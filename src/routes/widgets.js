const express  = require('express');
const router   = express.Router();
const db       = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const broadcast = require('../broadcast');

function setIO(io) { broadcast.setIO(io); }

function parseConfig(raw) {
  if (!raw || raw === '{}') return {};
  try { const p=JSON.parse(raw); return typeof p==='string'?JSON.parse(p):p; } catch { return {}; }
}

router.get('/', async (req, res, next) => {
  try {
    const { isAdmin, userId } = require('../middleware/tenant').tenantFilter(req);
    const rows = isAdmin
      ? await db.all('SELECT * FROM widgets ORDER BY created_at DESC')
      : await db.all('SELECT * FROM widgets WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC', [userId]);
    res.json(rows.map(r => ({ ...r, config: parseConfig(r.config) })));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, type, config={}, position='bottom', active=1, tv_ids='', rotation=0 } = req.body;
    if (!name||!type) return res.status(400).json({ error: 'name e type obrigatórios' });
    const id  = `widget-${uuidv4().substring(0,8)}`;
    const cfg = typeof config==='string' ? config : JSON.stringify(config);
    const tvStr = Array.isArray(tv_ids) ? tv_ids.join(',') : (tv_ids||'');
    const rot = [0,90,180,270].includes(Number(rotation)) ? Number(rotation) : 0;
    const { userId: wgtUserId } = require('../middleware/tenant').tenantFilter(req);
    await db.run('INSERT INTO widgets (id,name,type,config,position,active,tv_ids,rotation,user_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, name, type, cfg, position, active?1:0, tvStr, rot]);
    const row = await db.get('SELECT * FROM widgets WHERE id=?', [id]);
    broadcast.contentChanged(null, 'widget-created');
    res.status(201).json({ ...row, config: parseConfig(row.config) });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, config, position, active, tv_ids, rotation } = req.body;
    const cfg = config!==undefined ? (typeof config==='string'?config:JSON.stringify(config)) : null;
    const tvStr = tv_ids!==undefined ? (Array.isArray(tv_ids) ? tv_ids.join(',') : (tv_ids||'')) : null;
    const rot = rotation!==undefined ? ([0,90,180,270].includes(Number(rotation))?Number(rotation):0) : null;
    await db.run(
      `UPDATE widgets SET
        name=COALESCE(?,name), config=COALESCE(?,config),
        position=COALESCE(?,position), active=COALESCE(?,active),
        tv_ids=COALESCE(?,tv_ids), rotation=COALESCE(?,rotation)
       WHERE id=?`,
      [name??null, cfg, position??null, active!==undefined?(active?1:0):null, tvStr, rot, id]
    );
    const row = await db.get('SELECT * FROM widgets WHERE id=?', [id]);
    broadcast.contentChanged(null, 'widget-updated');
    res.json({ ...row, config: parseConfig(row.config) });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.run('DELETE FROM widgets WHERE id=?', [req.params.id]);
    broadcast.contentChanged(null, 'widget-deleted');
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setIO = setIO;
