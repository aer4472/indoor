/**
 * SMARTVISION PRO — Auth Routes
 * Login com brute force protection, password policy, audit log
 */
const express   = require('express');
const router    = express.Router();
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const db        = require('../database/db');
const { JWT_SECRET }  = require('../middleware/auth');
const { loginLimiter, auditLog } = require('../middleware/security');

// In-memory login attempt tracker (resets on restart — basta para proteção básica)
// Para produção de alta escala, use Redis
const loginAttempts = new Map();

function getAttempts(key) {
  const entry = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  return entry;
}

function recordAttempt(key, success) {
  const entry = getAttempts(key);
  if (success) {
    loginAttempts.delete(key);
    return;
  }
  entry.count = (entry.count || 0) + 1;
  // Lock for 15 min after 5 failures
  if (entry.count >= 5) {
    entry.lockedUntil = Date.now() + 15 * 60 * 1000;
  }
  loginAttempts.set(key, entry);
}

// ── POST /api/auth/login ──────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
    }

    // Sanitize
    const cleanUser = String(username).slice(0, 64).trim();

    // Check brute force lock
    const attemptKey = `${req.ip}:${cleanUser}`;
    const attempts   = getAttempts(attemptKey);
    if (attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
      const remaining = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
      await auditLog(null, cleanUser, 'login_blocked', 'auth', `Conta bloqueada temporariamente`, req);
      return res.status(429).json({
        error: `Conta bloqueada por excesso de tentativas. Aguarde ${remaining} minuto(s).`
      });
    }

    // Fetch user — timing-safe (sempre faz bcrypt mesmo se não existe)
    const user = await db.get('SELECT * FROM users WHERE username = $1', [cleanUser]);

    // Always run bcrypt to prevent timing attacks
    const dummyHash = '$2b$10$dummyhashtopreventtimingattacksXXXXXXXXXXXX';
    const valid = user
      ? await bcrypt.compare(String(password).slice(0, 128), user.password)
      : await bcrypt.compare('dummy', dummyHash).then(() => false);

    if (!user || !valid) {
      recordAttempt(attemptKey, false);
      const entry = getAttempts(attemptKey);
      const remaining = Math.max(0, 5 - entry.count);
      await auditLog(user?.id, cleanUser, 'login_failed', 'auth',
        `IP: ${req.ip} — tentativa ${entry.count}/5`, req);
      return res.status(401).json({
        error: remaining > 0
          ? `Credenciais inválidas. ${remaining} tentativa(s) restante(s).`
          : 'Conta bloqueada temporariamente.'
      });
    }

    // Success
    recordAttempt(attemptKey, true);

    // Get plan info
    const userPlan = await db.get(`
      SELECT p.name as plan_name, p.max_tvs,
             COALESCE(u.max_tvs_override, p.max_tvs, 0) as effective_max_tvs
      FROM users u LEFT JOIN plans p ON u.plan_id = p.id WHERE u.id = $1
    `, [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '24h' }
    );

    await auditLog(user.id, user.username, 'login_success', 'auth', `IP: ${req.ip}`, req);

    res.json({
      token,
      username: user.username,
      role: user.role,
      plan: userPlan?.plan_name || null,
      max_tvs: userPlan?.effective_max_tvs ?? 0,
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/auth/change-password ───────────────────────────────
router.post('/change-password', async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Não autorizado' });

    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user    = await db.get('SELECT * FROM users WHERE id = $1', [decoded.id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const { currentPassword, newPassword } = req.body;

    const valid = await bcrypt.compare(String(currentPassword).slice(0,128), user.password);
    if (!valid) {
      await auditLog(user.id, user.username, 'password_change_failed', 'auth', 'Senha atual incorreta', req);
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }

    // Password policy: min 8 chars, at least 1 number or special char
    const pwd = String(newPassword);
    if (pwd.length < 8) {
      return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres.' });
    }
    if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pwd)) {
      return res.status(400).json({ error: 'A senha deve conter ao menos um número ou caractere especial.' });
    }

    const hash = await bcrypt.hash(pwd, 12); // cost factor 12
    await db.run('UPDATE users SET password = $1 WHERE id = $2', [hash, user.id]);
    await auditLog(user.id, user.username, 'password_changed', 'auth', null, req);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
