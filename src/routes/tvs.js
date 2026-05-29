const express  = require('express');
const router   = express.Router();
const db       = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const broadcast = require('../broadcast');

function setIO(io) { broadcast.setIO(io); }

router.get('/', async (req, res, next) => {
  try {
    const tvs = await db.all('SELECT * FROM tvs ORDER BY created_at DESC');
    res.json(tvs);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, orientation='horizontal', playlist_id, volume=100, transition='fade' } = req.body;
    if (!name) return res.status(400).json({ error: 'name obrigatório' });
    const id = `tv-${uuidv4().substring(0,8)}`;
    await db.run(
      'INSERT INTO tvs (id,name,orientation,playlist_id,volume,transition,status) VALUES (?,?,?,?,?,?,?)',
      [id, name, orientation, playlist_id||null, volume, transition, 'offline']
    );
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [id]);
    res.status(201).json(tv);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, playlist_id, orientation, volume, transition } = req.body;
    await db.run(
      `UPDATE tvs SET
        name        = COALESCE(?,name),
        playlist_id = CASE WHEN ? IS NOT NULL THEN ? ELSE playlist_id END,
        orientation = COALESCE(?,orientation),
        volume      = COALESCE(?,volume),
        transition  = COALESCE(?,transition)
       WHERE id = ?`,
      [name, playlist_id!==undefined?1:null, playlist_id, orientation, volume, transition, id]
    );
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [id]);
    // Notificar esta TV para re-sincronizar (ex: playlist, volume, transição mudaram)
    broadcast.contentChanged(id, 'tv-config');
    res.json(tv);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.run('DELETE FROM tvs WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { next(e); }
});

// Recarregar TV(s) por force-reload
router.post('/reload', async (req, res, next) => {
  try {
    const { tv_id } = req.body; // null = todas as TVs
    broadcast.forceReload(tv_id || null);
    res.json({ success: true, target: tv_id || 'all' });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setIO = setIO;
