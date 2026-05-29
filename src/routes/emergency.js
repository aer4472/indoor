const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

let io = null;
function setIO(s) { io = s; }

router.get('/', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM emergency WHERE id=1');
    res.json(row || { active:0 });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { active, title, message, bg_color, text_color } = req.body;
    await db.run(
      `UPDATE emergency SET active=?,title=COALESCE(?,title),message=COALESCE(?,message),
       bg_color=COALESCE(?,bg_color),text_color=COALESCE(?,text_color),updated_at=? WHERE id=1`,
      [active?1:0, title, message, bg_color, text_color, new Date().toISOString()]
    );
    const row = await db.get('SELECT * FROM emergency WHERE id=1');
    // Broadcast para TODAS as TVs (sem exceção)
    if (io) io.emit('emergency-update', row);
    console.log(`🚨 Emergência ${row.active?'ATIVADA':'desativada'}`);
    res.json(row);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setIO = setIO;
