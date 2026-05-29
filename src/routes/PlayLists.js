const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const broadcast = require('../broadcast');

function setIO(io) { broadcast.setIO(io); }

async function getPlaylistWithVideos(id) {
  const videos = await db.all(`
    SELECT v.id, v.filename, v.original_name, v.duration, v.display_duration,
           v.media_type, v.mime_type, v.size, pv.order_position
    FROM videos v JOIN playlist_videos pv ON v.id = pv.video_id
    WHERE pv.playlist_id = ? ORDER BY pv.order_position
  `, [id]);
  return videos;
}

router.get('/', async (req, res, next) => {
  try {
    const playlists = await db.all('SELECT * FROM playlists ORDER BY created_at DESC');
    const result = await Promise.all(playlists.map(async p => ({
      ...p, videos: await getPlaylistWithVideos(p.id)
    })));
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const pl = await db.get('SELECT * FROM playlists WHERE id = ?', [req.params.id]);
    if (!pl) return res.status(404).json({ error: 'Não encontrada' });
    pl.videos = await getPlaylistWithVideos(pl.id);
    res.json(pl);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, videoIds = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'name obrigatório' });
    const id = `pl-${uuidv4().substring(0,8)}`;
    await db.run('INSERT INTO playlists (id, name) VALUES (?, ?)', [id, name]);
    for (let i = 0; i < videoIds.length; i++) {
      await db.run('INSERT INTO playlist_videos (playlist_id, video_id, order_position) VALUES (?, ?, ?)',
        [id, videoIds[i], i]);
    }
    const pl = await db.get('SELECT * FROM playlists WHERE id = ?', [id]);
    pl.videos = await getPlaylistWithVideos(id);
    // Notificar TVs que usam esta playlist (nova — normalmente nenhuma ainda)
    await broadcast.playlistChanged(id, db);
    res.status(201).json(pl);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, videoIds, shuffle } = req.body;
    if (name !== undefined) await db.run('UPDATE playlists SET name = ? WHERE id = ?', [name, id]);
    if (shuffle !== undefined) await db.run('UPDATE playlists SET shuffle = ? WHERE id = ?', [shuffle ? 1 : 0, id]);
    if (videoIds !== undefined) {
      await db.run('DELETE FROM playlist_videos WHERE playlist_id = ?', [id]);
      for (let i = 0; i < videoIds.length; i++) {
        await db.run('INSERT INTO playlist_videos (playlist_id, video_id, order_position) VALUES (?, ?, ?)',
          [id, videoIds[i], i]);
      }
    }
    const pl = await db.get('SELECT * FROM playlists WHERE id = ?', [id]);
    pl.videos = await getPlaylistWithVideos(id);
    // Notificar todas as TVs que usam esta playlist
    await broadcast.playlistChanged(id, db);
    res.json(pl);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    // Remover referência das TVs antes de deletar
    await db.run('UPDATE tvs SET playlist_id = NULL WHERE playlist_id = ?', [id]);
    await db.run('DELETE FROM playlists WHERE id = ?', [id]);
    broadcast.contentChanged(null, 'playlist-deleted');
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setIO = setIO;
