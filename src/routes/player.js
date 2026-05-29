const express = require('express');
const router = express.Router();
const db = require('../database/db');

let io = null;
function setIO(s) { io = s; }

// Autenticação por PIN da TV — rota pública
router.post('/auth-tv', async (req, res, next) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN obrigatório' });
    const tv = await db.get('SELECT id, name, pin FROM tvs WHERE pin = ?', [pin.toString().trim()]);
    if (!tv) return res.status(401).json({ error: 'PIN inválido' });
    res.json({ ok: true, tvId: tv.id, tvName: tv.name });
  } catch (e) { next(e); }
});

router.get('/tvs', async (req, res, next) => {
  try {
    const tvs = await db.all('SELECT id, name, status FROM tvs ORDER BY name ASC');
    res.json(tvs);
  } catch (e) { next(e); }
});

async function getPlaylistVideos(playlistId) {
  return db.all(`
    SELECT v.id, v.filename, v.original_name, v.duration, v.display_duration,
           v.media_type, v.config, v.rotation, pv.order_position
    FROM videos v JOIN playlist_videos pv ON v.id = pv.video_id
    WHERE pv.playlist_id = ? ORDER BY pv.order_position
  `, [playlistId]);
}

function parseConfig(raw) {
  if (!raw || raw === '{}') return {};
  try { const p = JSON.parse(raw); return typeof p === 'string' ? JSON.parse(p) : p; } catch { return {}; }
}

function mapVideo(v) {
  return {
    id: v.id,
    filename: v.filename,
    url: ['youtube','card'].includes(v.media_type) ? null : `/storage/videos/${v.filename}`,
    youtube_id:   v.media_type === 'youtube' ? v.filename : null,
    youtube_type: v.media_type === 'youtube' ? (v.mime_type === 'youtube_playlist' ? 'playlist' : 'video') : null,
    name: v.original_name,
    order: v.order_position,
    duration: v.duration,
    display_duration: v.display_duration || 10,
    media_type: v.media_type || 'video',
    config: parseConfig(v.config),
    rotation: v.rotation || 0,
  };
}

router.get('/:tvId/config', async (req, res, next) => {
  try {
    const { tvId } = req.params;
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [tvId]);
    if (!tv) return res.status(404).json({ error: 'TV não encontrada' });

    await db.run('UPDATE tvs SET last_seen = ?, status = ? WHERE id = ?',
      [new Date().toISOString(), 'online', tvId]);

    // Verificar agendamento ativo AGORA para esta TV
    const allSchedules = await db.all(
      'SELECT * FROM schedules WHERE tv_id = ? AND active = 1 ORDER BY start_time',
      [tvId]
    );

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const currentDay  = now.getDay(); // 0=Dom

    let activeSchedule = null;
    for (const s of allSchedules) {
      const days = JSON.parse(s.days || '[]');
      if (days.includes(currentDay) && currentTime >= s.start_time && currentTime <= s.end_time) {
        activeSchedule = s;
        break;
      }
    }

    // Usar playlist do agendamento ativo OU playlist padrão da TV
    const effectivePlaylistId = activeSchedule ? activeSchedule.playlist_id : tv.playlist_id;

    let videos = [];
    let playlistShuffle = false;
    if (effectivePlaylistId) {
      const plRow = await db.get('SELECT id, shuffle FROM playlists WHERE id = ?', [effectivePlaylistId]);
      if (plRow) {
        videos = await getPlaylistVideos(effectivePlaylistId);
        playlistShuffle = !!plRow.shuffle;
      } else if (!activeSchedule) {
        await db.run('UPDATE tvs SET playlist_id = NULL WHERE id = ?', [tvId]);
      }
    }

    const schedules = allSchedules;

    // Emergência
    const emergency = await db.get('SELECT * FROM emergency WHERE id = 1');

    // Widgets ativos
    const widgetRows = await db.all('SELECT * FROM widgets WHERE active = 1 ORDER BY position');
    const widgets = widgetRows.map(w => ({ ...w, config: JSON.parse(w.config || '{}') }));

    // Patrocinadores (grupos)
    const spGroupsRow = await db.get("SELECT value FROM settings WHERE key='sponsor_groups'");
    const sponsorGroups = spGroupsRow ? JSON.parse(spGroupsRow.value || '[]') : [];

    res.json({
      tv: { id: tv.id, name: tv.name, orientation: tv.orientation, playlist_id: tv.playlist_id, volume: tv.volume ?? 100, transition: tv.transition || 'fade' },
      playlist: videos.map(v => mapVideo(v)),
      shuffle: playlistShuffle,
      active_schedule: activeSchedule ? { id: activeSchedule.id, name: activeSchedule.name, playlist_id: activeSchedule.playlist_id } : null,
      schedules: schedules.map(s => ({ ...s, days: JSON.parse(s.days || '[]') })),
      emergency: emergency || { active: 0 },
      widgets,
      sponsorGroups,
      timestamp: new Date().toISOString()
    });
  } catch (e) { next(e); }
});

router.post('/:tvId/heartbeat', async (req, res, next) => {
  try {
    const { tvId } = req.params;
    const { currentVideo, playbackTime } = req.body;
    const tv = await db.get('SELECT id FROM tvs WHERE id = ?', [tvId]);
    if (!tv) return res.status(404).json({ error: 'TV não encontrada' });

    await db.run('UPDATE tvs SET last_seen = ?, status = ?, current_video = ?, playback_time = ? WHERE id = ?',
      [new Date().toISOString(), 'online', currentVideo || null, playbackTime || 0, tvId]);

    if (io) io.to('admin-panel').emit('tv-heartbeat', { tvId, currentVideo, playbackTime, timestamp: new Date().toISOString() });
    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setIO = setIO;
