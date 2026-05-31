const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../database/db');
const { adminOnly, auditLog } = require('../middleware/security');
const { getDaysRemaining } = require('../middleware/subscription');

// ── Listar usuários com plano e uso de TVs ────────────────────────
router.get('/', adminOnly, async (req, res, next) => {
  try {
    const users = await db.all(`
      SELECT u.id, u.username, u.role, u.created_at,
             u.plan_id, u.max_tvs_override,
             u.account_status, u.trial_ends_at, u.subscription_ends_at,
             u.suspended_reason, u.suspended_at,
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
    const daysRemaining = getDaysRemaining(user);
    res.json({ ...user, tvs, days_remaining: daysRemaining });
  } catch(e) { next(e); }
});

// ── Criar usuário ─────────────────────────────────────────────────
router.post('/', adminOnly, async (req, res, next) => {
  try {
    const { username, password, role = 'operator', plan_id } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username e password obrigatórios' });
    if (!['admin','operator','viewer'].includes(role)) return res.status(400).json({ error: 'role inválida' });
    if (password.length < 8) return res.status(400).json({ error: 'Senha mínima de 8 caracteres' });
    if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      return res.status(400).json({ error: 'A senha deve conter ao menos um número ou caractere especial.' });
    }
    const hash = await bcrypt.hash(password, 12);
    // Novo usuário começa com trial de 3 dias
    const trialEnds = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const r = await db.run(
      "INSERT INTO users (username, password, role, plan_id, account_status, trial_started_at, trial_ends_at) VALUES (?,?,?,?,'trial',NOW(),?)",
      [username, hash, role, plan_id || null, trialEnds]
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
      if (password.length < 8) return res.status(400).json({ error: 'Senha mínima de 8 caracteres' });
    if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      return res.status(400).json({ error: 'A senha deve conter ao menos um número ou caractere especial.' });
    }
      newHash = await bcrypt.hash(password, 12);
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

// ── Suspender conta ──────────────────────────────────────────────
router.post('/:id/suspend', adminOnly, async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.username === 'admin') return res.status(403).json({ error: 'Não é possível suspender o admin principal' });
    const { reason } = req.body;
    await db.run(
      "UPDATE users SET account_status='suspended', suspended_at=NOW(), suspended_by=$1, suspended_reason=$2 WHERE id=$3",
      [req.user?.username || 'admin', reason || 'Suspenso pelo administrador', req.params.id]
    );
    await auditLog(req.user?.id, req.user?.username, 'user_suspended', user.username, reason || null, req);
    res.json({ success: true, message: `Conta de ${user.username} suspensa.` });
  } catch(e) { next(e); }
});

// ── Reativar conta ────────────────────────────────────────────────
router.post('/:id/activate', adminOnly, async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    // Ao reativar, define assinatura por 30 dias por padrão
    const { days = 30 } = req.body;
    const subEnds = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
      "UPDATE users SET account_status='active', subscription_ends_at=$1, suspended_at=NULL, suspended_by=NULL, suspended_reason=NULL WHERE id=$2",
      [subEnds, req.params.id]
    );
    await auditLog(req.user?.id, req.user?.username, 'user_activated', user.username, `${days} dias`, req);
    res.json({ success: true, message: `Conta de ${user.username} reativada por ${days} dias.`, subscription_ends_at: subEnds });
  } catch(e) { next(e); }
});

// ── Renovar assinatura ────────────────────────────────────────────
router.post('/:id/renew', adminOnly, async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const { days = 30 } = req.body;
    // Se já tem assinatura vigente, adiciona dias em cima
    const base = user.subscription_ends_at && new Date(user.subscription_ends_at) > new Date()
      ? new Date(user.subscription_ends_at)
      : new Date();
    const subEnds = new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
      "UPDATE users SET account_status='active', subscription_ends_at=$1 WHERE id=$2",
      [subEnds, req.params.id]
    );
    await auditLog(req.user?.id, req.user?.username, 'subscription_renewed', user.username, `+${days} dias até ${subEnds.slice(0,10)}`, req);
    res.json({ success: true, message: `Assinatura renovada por mais ${days} dias.`, subscription_ends_at: subEnds });
  } catch(e) { next(e); }
});

// ── Deletar usuário ───────────────────────────────────────────────
router.delete('/:id', adminOnly, async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.username === 'admin') return res.status(403).json({ error: 'Não é possível remover o admin principal' });
    await db.run('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { next(e); }
});

module.exports = router;
