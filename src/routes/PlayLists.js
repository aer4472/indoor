const express   = require('express');
const router    = express.Router();
const db        = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const broadcast = require('../broadcast');
const { tenantFilter } = require('../middleware/tenant');

function setIO(io) { broadcast.setIO(io); }

async function getPlaylistWithVideos(id) {
  const videos = await db.all(`
    SELECT v.id, v.filename, v.original_name, v.duration, v.display_duration,
           v.media_type, v.mime_type, v.size, v.rotation, pv.order_position
    FROM videos v JOIN playlist_videos pv ON v.id = pv.video_id
    WHERE pv.playlist_id = ? ORDER BY pv.order_position
  `, [id]);
  return videos;
}

router.get('/', async (req, res, next) => {
  try {
    const { isAdmin, userId } = tenantFilter(req);
    const playlists = isAdmin
      ? await db.all('SELECT * FROM playlists ORDER BY created_at DESC')
      : await db.all('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    const result = await Promise.all(playlists.map(async p => ({
      ...p, videos: await getPlaylistWithVideos(p.id)
    })));
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { isAdmin, userId } = tenantFilter(req);
    const pl = await db.get('SELECT * FROM playlists WHERE id = ?', [req.params.id]);
    if (!pl) return res.status(404).json({ error: 'Não encontrada' });
    if (!isAdmin && pl.user_id !== userId) return res.status(403).json({ error: 'Acesso negado' });
    pl.videos = await getPlaylistWithVideos(pl.id);
    res.json(pl);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, videoIds = [], shuffle = 0 } = req.body;
    if (!name) return res.status(400).json({ error: 'name obrigatório' });
    const { userId } = tenantFilter(req);
    const id = `pl-${uuidv4().substring(0,8)}`;
    await db.run('INSERT INTO playlists (id,name,shuffle,user_id) VALUES (?,?,?,?)', [id, name, shuffle?1:0, userId||null]);
    if (videoIds.length) {
      for (let i = 0; i < videoIds.length; i++) {
        await db.run('INSERT INTO playlist_videos (playlist_id,video_id,order_position) VALUES (?,?,?)', [id, videoIds[i], i]);
      }
    }
    const pl = await db.get('SELECT * FROM playlists WHERE id = ?', [id]);
    pl.videos = await getPlaylistWithVideos(id);
    broadcast.playlistChanged();
    res.status(201).json(pl);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { isAdmin, userId } = tenantFilter(req);
    const pl = await db.get('SELECT * FROM playlists WHERE id = ?', [req.params.id]);
    if (!pl) return res.status(404).json({ error: 'Não encontrada' });
    if (!isAdmin && pl.user_id !== userId) return res.status(403).json({ error: 'Acesso negado' });

    const { name, videoIds, shuffle, rotation } = req.body;
    if (name) await db.run('UPDATE playlists SET name=?,shuffle=?,rotation=? WHERE id=?',
      [name, shuffle?1:0, rotation||0, req.params.id]);

    if (Array.isArray(videoIds)) {
      await db.run('DELETE FROM playlist_videos WHERE playlist_id=?', [req.params.id]);
      for (let i = 0; i < videoIds.length; i++) {
        await db.run('INSERT INTO playlist_videos (playlist_id,video_id,order_position) VALUES (?,?,?)',
          [req.params.id, videoIds[i], i]);
      }
    }
    const updated = await db.get('SELECT * FROM playlists WHERE id = ?', [req.params.id]);
    updated.videos = await getPlaylistWithVideos(req.params.id);
    broadcast.playlistChanged();
    res.json(updated);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { isAdmin, userId } = tenantFilter(req);
    const pl = await db.get('SELECT * FROM playlists WHERE id = ?', [req.params.id]);
    if (!pl) return res.status(404).json({ error: 'Não encontrada' });
    if (!isAdmin && pl.user_id !== userId) return res.status(403).json({ error: 'Acesso negado' });
    await db.run('DELETE FROM playlists WHERE id=?', [req.params.id]);
    broadcast.playlistChanged();
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = { router, setIO };
