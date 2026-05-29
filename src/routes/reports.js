const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

// Status de todas as TVs em tempo real
router.get('/status', async (req, res) => {
  const tvs = await db.all(`
    SELECT t.id, t.name, t.status, t.last_seen, t.current_video, t.playlist_id,
           p.name as playlist_name
    FROM tvs t LEFT JOIN playlists p ON t.playlist_id = p.id
    ORDER BY t.name
  `);
  // Marcar como offline se não enviou heartbeat nos últimos 2 minutos
  const now = Date.now();
  const result = tvs.map(tv => {
    const lastSeen = tv.last_seen ? new Date(tv.last_seen).getTime() : 0;
    const isOnline = (now - lastSeen) < 2 * 60 * 1000;
    return { ...tv, status: isOnline ? 'online' : 'offline', minutesAgo: Math.round((now-lastSeen)/60000) };
  });
  res.json(result);
});

// Log de reprodução (últimas 24h ou filtro)
router.get('/playback', async (req, res) => {
  const { tv_id, limit = 100, days = 1 } = req.query;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  let sql = `SELECT * FROM playback_log WHERE started_at >= ? `;
  const params = [since];
  if (tv_id) { sql += 'AND tv_id = ? '; params.push(tv_id); }
  sql += 'ORDER BY started_at DESC LIMIT ?';
  params.push(+limit);
  const rows = await db.all(sql, params);
  res.json(rows);
});

// Estatísticas resumidas
router.get('/stats', async (req, res) => {
  const [tvCount, onlineCount, totalPlays, topMedia] = await Promise.all([
    db.get('SELECT COUNT(*) as n FROM tvs'),
    db.get(`SELECT COUNT(*) as n FROM tvs WHERE last_seen >= datetime('now','-2 minutes')`),
    db.get('SELECT COUNT(*) as n FROM playback_log WHERE started_at >= datetime("now","-24 hours")'),
    db.all(`SELECT video_name, COUNT(*) as plays FROM playback_log
            WHERE started_at >= datetime('now','-7 days') AND video_name IS NOT NULL
            GROUP BY video_name ORDER BY plays DESC LIMIT 5`),
  ]);
  res.json({ tvCount: tvCount.n, onlineCount: onlineCount.n, playsToday: totalPlays.n, topMedia });
});

// Log de auditoria
router.get('/audit', async (req, res) => {
  const rows = await db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
});

// Registrar reprodução (chamado pelo player via heartbeat extendido)
router.post('/playback', async (req, res) => {
  const { tv_id, tv_name, video_name, media_type, duration_sec } = req.body;
  if (!tv_id) return res.status(400).json({ error: 'tv_id obrigatório' });
  await db.run(
    'INSERT INTO playback_log (tv_id,tv_name,video_name,media_type,duration_sec) VALUES (?,?,?,?,?)',
    [tv_id, tv_name||null, video_name||null, media_type||null, duration_sec||0]
  );
  res.json({ success: true });
});

module.exports = router;
