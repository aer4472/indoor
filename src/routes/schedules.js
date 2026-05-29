const express  = require('express');
const router   = express.Router();
const db       = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const broadcast = require('../broadcast');

function setIO(io) { broadcast.setIO(io); }

router.get('/', async (req, res, next) => {
  try {
    const { tv_id } = req.query;
    const sql = tv_id
      ? 'SELECT s.*,p.name as playlist_name FROM schedules s LEFT JOIN playlists p ON s.playlist_id=p.id WHERE s.tv_id=? ORDER BY s.start_time'
      : 'SELECT s.*,p.name as playlist_name,t.name as tv_name FROM schedules s LEFT JOIN playlists p ON s.playlist_id=p.id LEFT JOIN tvs t ON s.tv_id=t.id ORDER BY s.tv_id,s.start_time';
    const rows = await db.all(sql, tv_id ? [tv_id] : []);
    res.json(rows.map(r => ({ ...r, days: JSON.parse(r.days||'[]') })));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { tv_id, playlist_id, name, start_time, end_time, days=[0,1,2,3,4,5,6] } = req.body;
    if (!tv_id||!playlist_id||!start_time||!end_time)
      return res.status(400).json({ error: 'tv_id, playlist_id, start_time e end_time obrigatórios' });
    const id = `sched-${uuidv4().substring(0,8)}`;
    await db.run(
      'INSERT INTO schedules (id,tv_id,playlist_id,name,start_time,end_time,days) VALUES (?,?,?,?,?,?,?)',
      [id, tv_id, playlist_id, name||`${start_time}–${end_time}`, start_time, end_time, JSON.stringify(days)]
    );
    const row = await db.get('SELECT * FROM schedules WHERE id = ?', [id]);
    broadcast.contentChanged(tv_id, 'schedule-created');
    res.status(201).json({ ...row, days: JSON.parse(row.days) });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { playlist_id, name, start_time, end_time, days, active } = req.body;
    const old = await db.get('SELECT tv_id FROM schedules WHERE id=?', [id]);
    await db.run(
      `UPDATE schedules SET
        playlist_id=COALESCE(?,playlist_id), name=COALESCE(?,name),
        start_time=COALESCE(?,start_time),   end_time=COALESCE(?,end_time),
        days=COALESCE(?,days),               active=COALESCE(?,active)
       WHERE id=?`,
      [playlist_id, name, start_time, end_time, days?JSON.stringify(days):null, active, id]
    );
    const row = await db.get('SELECT * FROM schedules WHERE id=?', [id]);
    if (old?.tv_id) broadcast.contentChanged(old.tv_id, 'schedule-updated');
    res.json({ ...row, days: JSON.parse(row.days) });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const old = await db.get('SELECT tv_id FROM schedules WHERE id=?', [req.params.id]);
    await db.run('DELETE FROM schedules WHERE id=?', [req.params.id]);
    if (old?.tv_id) broadcast.contentChanged(old.tv_id, 'schedule-deleted');
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setIO = setIO;
