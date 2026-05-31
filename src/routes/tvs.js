const express  = require('express');
const router   = express.Router();
const db       = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const broadcast = require('../broadcast');

function setIO(io) { broadcast.setIO(io); }

function genPin() {
  // Gera PIN de 6 dígitos único e fácil de digitar
  return Math.floor(100000 + Math.random() * 900000).toString();
}

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

    // ── Verificar limite de TVs do plano ──────────────────────────
    if (req.user) {
      const userData = await db.get(`
        SELECT COALESCE(u.max_tvs_override, p.max_tvs, 0) as max_tvs,
               COUNT(DISTINCT t.id) as tvs_used
        FROM users u
        LEFT JOIN plans p ON u.plan_id = p.id
        LEFT JOIN tvs t ON t.user_id = u.id
        WHERE u.id = ?
        GROUP BY u.id, u.max_tvs_override, p.max_tvs
      `, [req.user.id]);
      if (userData && userData.max_tvs !== -1 && parseInt(userData.tvs_used) >= parseInt(userData.max_tvs)) {
        return res.status(403).json({
          error: `Limite de TVs atingido`,
          limit: userData.max_tvs,
          used: userData.tvs_used,
          upgrade: true
        });
      }
    }

    const id = `tv-${uuidv4().substring(0,8)}`;
    const pin = genPin();
    const userId = req.user?.id || null;
    await db.run(
      'INSERT INTO tvs (id,name,orientation,playlist_id,volume,transition,status,pin,user_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, name, orientation, playlist_id||null, volume, transition, 'offline', pin, userId]
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

// Desconectar TV — limpa tvId do player via Socket e reseta PIN
router.post('/:id/disconnect', async (req, res, next) => {
  try {
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    if (!tv) return res.status(404).json({ error: 'TV não encontrada' });

    // Gera novo PIN para invalidar a sessão atual
    const newPin = genPin();
    await db.run('UPDATE tvs SET pin = ?, status = ? WHERE id = ?', [newPin, 'offline', req.params.id]);

    // Envia comando via Socket para o player se desconectar
    broadcast.toTV(req.params.id, 'force-disconnect', { message: 'Desconectado pelo administrador' });

    const updated = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (e) { next(e); }
});

// Gerar novo PIN para uma TV
router.post('/:id/regen-pin', async (req, res, next) => {
  try {
    const pin = genPin();
    await db.run('UPDATE tvs SET pin = ? WHERE id = ?', [pin, req.params.id]);
    const tv = await db.get('SELECT * FROM tvs WHERE id = ?', [req.params.id]);
    res.json(tv);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setIO = setIO;
