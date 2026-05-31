const express   = require('express');
const router    = express.Router();
const db        = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const broadcast = require('../broadcast');
const { tenantFilter } = require('../middleware/tenant');

function setIO(io) { broadcast.setIO(io); }

function genPin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── GET / — lista só as TVs do usuário (admin vê todas) ───────────
router.get('/', async (req, res, next) => {
  try {
    const { isAdmin, userId } = tenantFilter(req);
    const tvs = isAdmin
      ? await db.all('SELECT * FROM tvs ORDER BY created_at DESC')
      : await db.all('SELECT * FROM tvs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    res.json(tvs);
  } catch (e) { next(e); }
});

// ── POST / — cria TV com user_id e verifica limite ────────────────
router.post('/', async (req, res, next) => {
  try {
    const { name, orientation='horizontal', playlist_id, volume=100, transition='fade' } = req.body;
    if (!name) return res.status(400).json({ error: 'name obrigatório' });

    const { isAdmin, userId } = tenantFilter(req);

    // Verifica limite do plano (admin nunca tem limite)
    if (!isAdmin && userId) {
      const userData = await db.get(`
        SELECT COALESCE(u.max_tvs_override, p.max_tvs, 0) as max_tvs,
               COUNT(DISTINCT t.id) as tvs_used
        FROM users u
        LEFT JOIN plans p ON u.plan_id = p.id
        LEFT JOIN tvs t ON t.user_id = u.id
        WHERE u.id = ?
        GROUP BY u.id, u.max_tvs_override, p.max_tvs
      `, [userId]);
      if (userData && parseInt(userData.max_tvs) !== -1 && parseInt(userData.tvs_used) >= parseInt(userData.max_tvs)) {
        return res.status(403).json({
          error: `Limite de TVs atingido`,
          limit: userData.max_tvs,
          used: userData.tvs_used,
          upgrade: true
        });
      }
    }

    const id  = `tv-${uuidv4().substring(0,8)}`;
    const pin = genPin();
    await db.run(
      'INSERT INTO tvs (id,name,orientation,playlist_id,volume,transition,status,pin,user_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, name, orientation, playlist_id||null, volume, transition, 'offline', pin, userId||null]
    );
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [id]);
    res.status(201).json(tv);
  } catch (e) { next(e); }
});

// ── PUT /:id ──────────────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { isAdmin, userId } = tenantFilter(req);
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    if (!tv) return res.status(404).json({ error: 'TV não encontrada' });
    if (!isAdmin && tv.user_id !== userId) return res.status(403).json({ error: 'Acesso negado' });

    const { name, playlist_id, orientation, volume, transition } = req.body;
    // Build dynamic update to avoid overwriting unchanged fields
    const updates = [];
    const params  = [];
    if (name        !== undefined) { updates.push('name = ?');        params.push(name); }
    if (playlist_id !== undefined) { updates.push('playlist_id = ?'); params.push(playlist_id||null); }
    if (orientation !== undefined) { updates.push('orientation = ?'); params.push(orientation); }
    if (volume      !== undefined) { updates.push('volume = ?');      params.push(volume); }
    if (transition  !== undefined) { updates.push('transition = ?');  params.push(transition); }
    if (updates.length === 0) return res.json(await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]));
    params.push(req.params.id);
    await db.run(`UPDATE tvs SET ${updates.join(', ')} WHERE id = ?`, params);
    const updated = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    broadcast.contentChanged(req.params.id, 'tv-config');
    res.json(updated);
  } catch (e) { next(e); }
});

// ── DELETE /:id ───────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { isAdmin, userId } = tenantFilter(req);
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    if (!tv) return res.status(404).json({ error: 'TV não encontrada' });
    if (!isAdmin && tv.user_id !== userId) return res.status(403).json({ error: 'Acesso negado' });
    await db.run('DELETE FROM tvs WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ── POST /reload ──────────────────────────────────────────────────
router.post('/reload', async (req, res, next) => {
  try {
    const { tv_id } = req.body;
    const { isAdmin, userId } = tenantFilter(req);
    if (tv_id) {
      const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [tv_id]);
      if (!isAdmin && tv?.user_id !== userId) return res.status(403).json({ error: 'Acesso negado' });
      broadcast.reloadTV(tv_id);
    } else {
      broadcast.reloadAll();
    }
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ── POST /:id/regen-pin ───────────────────────────────────────────
router.post('/:id/regen-pin', async (req, res, next) => {
  try {
    const { isAdmin, userId } = tenantFilter(req);
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    if (!tv) return res.status(404).json({ error: 'TV não encontrada' });
    if (!isAdmin && tv.user_id !== userId) return res.status(403).json({ error: 'Acesso negado' });
    const pin = genPin();
    await db.run('UPDATE tvs SET pin = ? WHERE id = ?', [pin, req.params.id]);
    const updated = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (e) { next(e); }
});

// ── POST /:id/disconnect ──────────────────────────────────────────
router.post('/:id/disconnect', async (req, res, next) => {
  try {
    const { isAdmin, userId } = tenantFilter(req);
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    if (!tv) return res.status(404).json({ error: 'TV não encontrada' });
    if (!isAdmin && tv.user_id !== userId) return res.status(403).json({ error: 'Acesso negado' });
    const pin = genPin();
    await db.run('UPDATE tvs SET pin = ?, status = ? WHERE id = ?', [pin, 'offline', req.params.id]);
    broadcast.toTV(req.params.id, 'force-disconnect', { message: 'Desconectado pelo administrador' });
    const updated = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (e) { next(e); }
});

module.exports = { router, setIO };
