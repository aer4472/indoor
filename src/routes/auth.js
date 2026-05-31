// src/routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const { JWT_SECRET } = require('../middleware/auth');

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
    }

    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // Busca plano do usuário
    const userPlan = await db.get(`
      SELECT p.name as plan_name, p.max_tvs,
             COALESCE(u.max_tvs_override, p.max_tvs, 0) as effective_max_tvs
      FROM users u LEFT JOIN plans p ON u.plan_id = p.id WHERE u.id = $1
    `, [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

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

router.post('/change-password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Não autorizado' });

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [decoded.id]);

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });

    if (newPassword.length < 6) return res.status(400).json({ error: 'Nova senha deve ter ao menos 6 caracteres' });

    const hash = await bcrypt.hash(newPassword, 10);
    await db.run('UPDATE users SET password = ? WHERE id = ?', [hash, user.id]);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
