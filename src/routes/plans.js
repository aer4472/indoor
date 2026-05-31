const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

// ── Listar planos ─────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const plans = await db.all(`
      SELECT p.*,
        COUNT(DISTINCT u.id) as users_count
      FROM plans p
      LEFT JOIN users u ON u.plan_id = p.id
      GROUP BY p.id ORDER BY p.max_tvs ASC
    `);
    res.json(plans);
  } catch(e) { next(e); }
});

// ── Criar plano ───────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { name, max_tvs, description = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'name obrigatório' });
    if (max_tvs === undefined) return res.status(400).json({ error: 'max_tvs obrigatório' });
    const r = await db.run(
      'INSERT INTO plans (name, max_tvs, description) VALUES (?,?,?)',
      [name.trim(), parseInt(max_tvs), description.trim()]
    );
    const plan = await db.get('SELECT * FROM plans WHERE id = $1', [r.id]);
    res.status(201).json(plan);
  } catch(e) {
    if (e.message?.includes('unique') || e.code === '23505')
      return res.status(409).json({ error: 'Já existe um plano com esse nome' });
    next(e);
  }
});

// ── Atualizar plano ───────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { name, max_tvs, description } = req.body;
    const plan = await db.get('SELECT * FROM plans WHERE id = ?', [req.params.id]);
    if (!plan) return res.status(404).json({ error: 'Plano não encontrado' });
    await db.run(
      'UPDATE plans SET name=?, max_tvs=?, description=?, updated_at=NOW() WHERE id=?',
      [
        name ?? plan.name,
        max_tvs !== undefined ? parseInt(max_tvs) : plan.max_tvs,
        description ?? plan.description,
        req.params.id
      ]
    );
    const updated = await db.get('SELECT * FROM plans WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch(e) { next(e); }
});

// ── Deletar plano ─────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const users = await db.all('SELECT id FROM users WHERE plan_id = ?', [req.params.id]);
    if (users.length > 0)
      return res.status(400).json({ error: `Plano em uso por ${users.length} usuário(s). Altere o plano deles primeiro.` });
    await db.run('DELETE FROM plans WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { next(e); }
});

module.exports = router;
