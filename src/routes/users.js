const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../database/db');

// Listar usuários
router.get('/', async (req, res) => {
  const users = await db.all('SELECT id, username, role, created_at FROM users ORDER BY id');
  res.json(users);
});

// Criar usuário
router.post('/', async (req, res) => {
  const { username, password, role = 'operator' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username e password obrigatórios' });
  if (!['admin','operator','viewer'].includes(role)) return res.status(400).json({ error: 'role inválida' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await db.run('INSERT INTO users (username, password, role) VALUES (?,?,?)', [username, hash, role]);
    await db.run('INSERT INTO audit_log (user,action,target,detail) VALUES (?,?,?,?)',
      [req.user?.username||'admin','create_user',username,`role:${role}`]);
    res.json({ id: r.id, username, role });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Usuário já existe' });
    throw e;
  }
});

// Atualizar usuário
router.put('/:id', async (req, res) => {
  const { username, password, role } = req.body;
  const user = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  // Proteger usuário admin principal
  if (user.username === 'admin' && role && role !== 'admin')
    return res.status(403).json({ error: 'Não é possível rebaixar o admin principal' });
  if (role && !['admin','operator','viewer'].includes(role))
    return res.status(400).json({ error: 'role inválida' });
  const newUsername = username || user.username;
  const newRole = role || user.role;
  let newHash = user.password;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });
    newHash = await bcrypt.hash(password, 10);
  }
  await db.run('UPDATE users SET username=?,password=?,role=? WHERE id=?',
    [newUsername, newHash, newRole, req.params.id]);
  await db.run('INSERT INTO audit_log (user,action,target) VALUES (?,?,?)',
    [req.user?.username||'admin','update_user',newUsername]);
  res.json({ id: +req.params.id, username: newUsername, role: newRole });
});

// Deletar usuário
router.delete('/:id', async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.username === 'admin') return res.status(403).json({ error: 'Não é possível remover o admin principal' });
  await db.run('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
