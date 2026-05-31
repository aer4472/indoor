const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../database/db');

// ── Listar usuários com plano e uso de TVs ────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const users = await db.all(`
      SELECT u.id, u.username, u.role, u.created_at,
             u.plan_id, u.max_tvs_override,
             p.name as plan_name, p.max_tvs as plan_max_tvs,
             COALESCE(u.max_tvs_override, p.max_tvs, 0) as effective_max_tvs,
             COUNT(DISTINCT t.id) as tvs_used
      FROM users u
      LEFT JOIN plans p ON u.plan_id = p.id
      LEFT JOIN tvs t ON t.user_id = u.id
      GROUP BY u.id, u.username, u.role, u.created_at, u.plan_id,
               u.max_tvs_override, p.name, p.max_tvs
      ORDER BY u.id
    `);
    res.json(users);
  } catch(e) { next(e); }
});

// ── Meu perfil (usuário logado) ───────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const user = await db.get(`
      SELECT u.id, u.username, u.role,
             u.plan_id, u.max_tvs_override,
             p.name as plan_name, p.max_tvs as plan_max_tvs, p.description as plan_description,
             COALESCE(u.max_tvs_override, p.max_tvs, 0) as effective_max_tvs,
             COUNT(DISTINCT t.id) as tvs_used
      FROM users u
      LEFT JOIN plans p ON u.plan_id = p.id
      LEFT JOIN tvs t ON t.user_id = u.id
      WHERE u.id = ?
      GROUP BY u.id, u.username, u.role, u.plan_id, u.max_tvs_override,
               p.name, p.max_tvs, p.description
    `, [req.user.id]);
    // TVs do usuário
    const tvs = await db.all(`
      SELECT t.id, t.name, t.status, t.last_seen, t.pin,
             p.name as playlist_name
      FROM tvs t
      LEFT JOIN playlists p ON t.playlist_id = p.id
      WHERE t.user_id = ?
      ORDER BY t.created_at DESC
    `, [req.user.id]);
    res.json({ ...user, tvs });
  } catch(e) { next(e); }
});

// ── Criar usuário ─────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { username, password, role = 'operator', plan_id } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username e password obrigatórios' });
    if (!['admin','operator','viewer'].includes(role)) return res.status(400).json({ error: 'role inválida' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });
    const hash = await bcrypt.hash(password, 10);
    const r = await db.run(
      'INSERT INTO users (username, password, role, plan_id) VALUES (?,?,?,?)',
      [username, hash, role, plan_id || null]
    );
    await db.run('INSERT INTO audit_log ("user",action,target,detail) VALUES (?,?,?,?)',
      [req.user?.username||'admin','create_user',username,`role:${role}`]);
    const created = await db.get('SELECT id, username, role, plan_id FROM users WHERE id = $1', [r.id]);
    res.json(created);
  } catch(e) {
    if (e.code === '23505' || e.message?.includes('unique') || e.message?.includes('duplicate')) return res.status(409).json({ error: 'Usuário já existe' });
    next(e);
  }
});

// ── Atualizar usuário ─────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { username, password, role, plan_id, max_tvs_override } = req.body;
    const user = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.username === 'admin' && role && role !== 'admin')
      return res.status(403).json({ error: 'Não é possível rebaixar o admin principal' });
    if (role && !['admin','operator','viewer'].includes(role))
      return res.status(400).json({ error: 'role inválida' });
    const newUsername = username || user.username;
    const newRole     = role ?? user.role;
    const newPlanId   = plan_id !== undefined ? (plan_id || null) : user.plan_id;
    const newOverride = max_tvs_override !== undefined ? (max_tvs_override === '' ? null : parseInt(max_tvs_override)) : user.max_tvs_override;
    let newHash = user.password;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });
      newHash = await bcrypt.hash(password, 10);
    }
    await db.run(
      'UPDATE users SET username=?,password=?,role=?,plan_id=?,max_tvs_override=? WHERE id=?',
      [newUsername, newHash, newRole, newPlanId, newOverride, req.params.id]
    );
    await db.run('INSERT INTO audit_log ("user",action,target) VALUES (?,?,?)',
      [req.user?.username||'admin','update_user',newUsername]);
    const updated = await db.get(`
      SELECT u.id, u.username, u.role, u.plan_id, u.max_tvs_override,
             p.name as plan_name, p.max_tvs as plan_max_tvs,
             COALESCE(u.max_tvs_override, p.max_tvs, 0) as effective_max_tvs
      FROM users u LEFT JOIN plans p ON u.plan_id = p.id WHERE u.id = ?
    `, [req.params.id]);
    res.json(updated);
  } catch(e) { next(e); }
});

// ── Deletar usuário ───────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.username === 'admin') return res.status(403).json({ error: 'Não é possível remover o admin principal' });
    await db.run('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { next(e); }
});

module.exports = router;
