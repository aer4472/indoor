// sponsors.js — grupos de patrocinadores por posição
// Estrutura: groups = [ { id, name, position, active, rotation, config:{...}, logos:[{id,url,filename,name}] } ]
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const db      = require('../database/db');

const LOGOS_DIR = path.join(__dirname, '../../storage/logos');

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await fs.mkdir(LOGOS_DIR, { recursive: true });
    cb(null, LOGOS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `sp-${uuidv4().substring(0,8)}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = ['image/png','image/jpeg','image/jpg','image/gif','image/webp','image/svg+xml'];
    ok.includes(file.mimetype) ? cb(null,true) : cb(new Error('Apenas PNG, JPG, GIF, WebP, SVG'));
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

async function getGroups() {
  const row = await db.get("SELECT value FROM settings WHERE key='sponsor_groups'");
  try { return row ? JSON.parse(row.value) : []; } catch { return []; }
}
async function saveGroups(groups) {
  await db.run(
    "INSERT INTO settings (key,value) VALUES ('sponsor_groups',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [JSON.stringify(groups)]
  );
}

// GET /api/sponsors
router.get('/', async (req, res, next) => {
  try { res.json({ groups: await getGroups() }); } catch(e) { next(e); }
});

// POST /api/sponsors/groups — criar grupo
router.post('/groups', async (req, res, next) => {
  try {
    const { name, position } = req.body;
    const groups = await getGroups();
    const group = {
      id:       uuidv4().substring(0,8),
      name:     name || 'Grupo',
      position: position || 'bl',
      active:   true,
      rotation: 0, // rotação das imagens em graus
      config: {
        width: 160, height: 80,
        interval: 5,
        opacity: 0.9,
        bg: 'rgba(0,0,0,0.45)',
        radius: 8,
      },
      logos: []
    };
    groups.push(group);
    await saveGroups(groups);
    res.json(group);
  } catch(e) { next(e); }
});

// PUT /api/sponsors/groups/:gid — atualizar config do grupo
router.put('/groups/:gid', async (req, res, next) => {
  try {
    const groups = await getGroups();
    const idx = groups.findIndex(g => g.id === req.params.gid);
    if (idx < 0) return res.status(404).json({ error: 'Grupo não encontrado' });
    const { name, position, active, rotation, config } = req.body;
    if (name     !== undefined) groups[idx].name     = name;
    if (position !== undefined) groups[idx].position = position;
    if (active   !== undefined) groups[idx].active   = active;
    if (rotation !== undefined) groups[idx].rotation = Number(rotation);
    if (config   !== undefined) groups[idx].config   = { ...groups[idx].config, ...config };
    await saveGroups(groups);
    res.json(groups[idx]);
  } catch(e) { next(e); }
});

// DELETE /api/sponsors/groups/:gid — remover grupo inteiro
router.delete('/groups/:gid', async (req, res, next) => {
  try {
    let groups = await getGroups();
    const group = groups.find(g => g.id === req.params.gid);
    if (group) {
      // Deletar todos os arquivos de logos do grupo
      for (const logo of group.logos || []) {
        await fs.unlink(path.join(LOGOS_DIR, logo.filename)).catch(() => {});
      }
      groups = groups.filter(g => g.id !== req.params.gid);
      await saveGroups(groups);
    }
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// POST /api/sponsors/groups/:gid/upload — adicionar logo ao grupo
router.post('/groups/:gid/upload', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
    const groups = await getGroups();
    const group  = groups.find(g => g.id === req.params.gid);
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
    const logo = {
      id:       uuidv4().substring(0,8),
      url:      `/storage/logos/${req.file.filename}`,
      filename: req.file.filename,
      name:     req.body.name || req.file.originalname,
    };
    group.logos.push(logo);
    await saveGroups(groups);
    res.json(logo);
  } catch(e) { next(e); }
});

// DELETE /api/sponsors/groups/:gid/logos/:lid — remover logo específico
router.delete('/groups/:gid/logos/:lid', async (req, res, next) => {
  try {
    const groups = await getGroups();
    const group  = groups.find(g => g.id === req.params.gid);
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
    const logo = group.logos.find(l => l.id === req.params.lid);
    if (logo) {
      await fs.unlink(path.join(LOGOS_DIR, logo.filename)).catch(() => {});
      group.logos = group.logos.filter(l => l.id !== req.params.lid);
      await saveGroups(groups);
    }
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// PUT /api/sponsors/groups/:gid/order — reordenar logos
router.put('/groups/:gid/order', async (req, res, next) => {
  try {
    const { ids } = req.body;
    const groups = await getGroups();
    const group  = groups.find(g => g.id === req.params.gid);
    if (!group) return res.status(404).json({ error: 'Grupo não encontrado' });
    group.logos = ids.map(id => group.logos.find(l => l.id === id)).filter(Boolean);
    await saveGroups(groups);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

module.exports = router;
