// src/routes/backup.js
// Exporta/importa TVs, Playlists, vínculos playlist-vídeo e agendamentos
// NÃO inclui arquivos de mídia — só referências (video_id, filename, original_name)

const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const broadcast = require('../broadcast');

const VERSION = 2; // versão do formato de backup

// ── GET /api/backup — gera o JSON de backup ───────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const tvs        = await db.all('SELECT id,name,playlist_id,orientation,volume,transition FROM tvs ORDER BY created_at');
    const playlists  = await db.all('SELECT id,name,rotation FROM playlists ORDER BY created_at');
    const pv         = await db.all(`
      SELECT pv.playlist_id, pv.video_id, pv.order_position,
             v.original_name, v.media_type, v.display_duration, v.duration,
             v.filename, v.config, v.rotation AS video_rotation
        FROM playlist_videos pv
        JOIN videos v ON v.id = pv.video_id
       ORDER BY pv.playlist_id, pv.order_position
    `);
    const schedules  = await db.all('SELECT id,tv_id,playlist_id,name,start_time,end_time,days,active FROM schedules ORDER BY created_at');
    const widgets    = await db.all('SELECT id,name,type,config,position,active,tv_ids,rotation FROM widgets ORDER BY created_at');

    const payload = {
      _version:    VERSION,
      _exported_at: new Date().toISOString(),
      tvs,
      playlists,
      playlist_videos: pv,
      schedules,
      widgets,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="indoortv-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(payload);
  } catch (e) { next(e); }
});

// ── POST /api/backup/restore — restaura a partir de um JSON ──────────────
router.post('/restore', async (req, res, next) => {
  try {
    const data = req.body;

    if (!data || !data.tvs || !data.playlists) {
      return res.status(400).json({ error: 'Arquivo de backup inválido ou incompleto.' });
    }

    const report = { tvs:0, playlists:0, playlist_videos:0, schedules:0, widgets:0, skipped:0 };

    // ── Playlists ──────────────────────────────────────────────────
    for (const p of (data.playlists || [])) {
      const exists = await db.get('SELECT id FROM playlists WHERE id=?', [p.id]);
      if (exists) { report.skipped++; continue; }
      await db.run(
        'INSERT INTO playlists (id,name,rotation) VALUES (?,?,?)',
        [p.id, p.name, p.rotation||0]
      );
      report.playlists++;
    }

    // ── Vídeos referenciados (apenas cards e youtube — sem arquivo físico) ─
    // Para vídeos normais, só recria o registro se o arquivo existir
    const fs   = require('fs');
    const path = require('path');
    const storageDir = path.join(__dirname, '../../storage/videos');

    for (const pv of (data.playlist_videos || [])) {
      const videoExists = await db.get('SELECT id FROM videos WHERE id=?', [pv.video_id]);
      if (!videoExists) {
        // Verificar se o arquivo físico existe (para vídeos/imagens/PDFs)
        const isCard    = ['clock_card','weather_card','weather_clock','slide'].includes(pv.media_type);
        const isYoutube = pv.media_type === 'youtube';
        const fileOk    = isCard || isYoutube || fs.existsSync(path.join(storageDir, pv.filename));
        if (!fileOk) { report.skipped++; continue; }

        const config = typeof pv.config === 'string' ? pv.config : JSON.stringify(pv.config||'{}');
        await db.run(
          `INSERT INTO videos
             (id,filename,original_name,display_duration,duration,size,mime_type,media_type,config,rotation)
           VALUES (?,?,?,?,?,0,'restored',?,?,?)
           ON CONFLICT (id) DO NOTHING`,
          [pv.video_id, pv.filename, pv.original_name,
           pv.display_duration||10, pv.duration||0,
           pv.media_type, config, pv.video_rotation||0]
        );
      }
    }

    // ── Playlist-Vídeo vínculos ────────────────────────────────────
    for (const pv of (data.playlist_videos || [])) {
      const plExists  = await db.get('SELECT id FROM playlists WHERE id=?', [pv.playlist_id]);
      const vidExists = await db.get('SELECT id FROM videos WHERE id=?',    [pv.video_id]);
      if (!plExists || !vidExists) { report.skipped++; continue; }
      const linkExists = await db.get(
        'SELECT id FROM playlist_videos WHERE playlist_id=? AND video_id=?',
        [pv.playlist_id, pv.video_id]
      );
      if (linkExists) { report.skipped++; continue; }
      await db.run(
        'INSERT INTO playlist_videos (playlist_id,video_id,order_position) VALUES (?,?,?)',
        [pv.playlist_id, pv.video_id, pv.order_position]
      );
      report.playlist_videos++;
    }

    // ── TVs ───────────────────────────────────────────────────────
    for (const t of (data.tvs || [])) {
      const exists = await db.get('SELECT id FROM tvs WHERE id=?', [t.id]);
      if (exists) { report.skipped++; continue; }
      await db.run(
        `INSERT INTO tvs (id,name,playlist_id,orientation,volume,transition)
         VALUES (?,?,?,?,?,?)`,
        [t.id, t.name, t.playlist_id||null, t.orientation||'horizontal', t.volume||100, t.transition||'fade']
      );
      report.tvs++;
    }

    // ── Agendamentos ──────────────────────────────────────────────
    for (const s of (data.schedules || [])) {
      const exists = await db.get('SELECT id FROM schedules WHERE id=?', [s.id]);
      if (exists) { report.skipped++; continue; }
      const tvOk = await db.get('SELECT id FROM tvs WHERE id=?',       [s.tv_id]);
      const plOk = await db.get('SELECT id FROM playlists WHERE id=?', [s.playlist_id]);
      if (!tvOk || !plOk) { report.skipped++; continue; }
      await db.run(
        `INSERT INTO schedules (id,tv_id,playlist_id,name,start_time,end_time,days,active)
         VALUES (?,?,?,?,?,?,?,?)`,
        [s.id, s.tv_id, s.playlist_id, s.name, s.start_time, s.end_time, s.days, s.active??1]
      );
      report.schedules++;
    }

    // ── Widgets ───────────────────────────────────────────────────
    for (const w of (data.widgets || [])) {
      const exists = await db.get('SELECT id FROM widgets WHERE id=?', [w.id]);
      if (exists) { report.skipped++; continue; }
      const cfg = typeof w.config === 'string' ? w.config : JSON.stringify(w.config||{});
      await db.run(
        `INSERT INTO widgets (id,name,type,config,position,active,tv_ids,rotation)
         VALUES (?,?,?,?,?,?,?,?)`,
        [w.id, w.name, w.type, cfg, w.position||'corner-tr', w.active??1, w.tv_ids||'', w.rotation||0]
      );
      report.widgets++;
    }

    broadcast.contentChanged(null, 'backup-restored');
    res.json({ success: true, report });
  } catch (e) { next(e); }
});

module.exports = router;
