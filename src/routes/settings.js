const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const db      = require('../database/db');

// Pasta de logos do painel e patrocinadores
const LOGOS_DIR = path.join(__dirname, '../../storage/logos');

const logoStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await fs.mkdir(LOGOS_DIR, { recursive: true });
    cb(null, LOGOS_DIR);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `${uuidv4().substring(0,8)}${ext}`;
    cb(null, name);
  }
});

const uploadLogo = multer({
  storage: logoStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png','image/jpeg','image/jpg','image/gif','image/webp','image/svg+xml'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas PNG, JPG, GIF, WebP e SVG são permitidos'));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// Ler todas as configurações como objeto
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.all('SELECT key, value FROM settings');
    const result = {};
    rows.forEach(r => {
      try { result[r.key] = JSON.parse(r.value); }
      catch { result[r.key] = r.value; }
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Salvar/atualizar configurações (key-value)
router.post('/', async (req, res, next) => {
  try {
    const settings = req.body; // { key: value, ... }
    for (const [key, value] of Object.entries(settings)) {
      const v = typeof value === 'string' ? value : JSON.stringify(value);
      await db.run(
        'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [key, v]
      );
    }
    // Retornar settings completas
    const rows = await db.all('SELECT key,value FROM settings');
    const result = {};
    rows.forEach(r => { try { result[r.key]=JSON.parse(r.value); } catch { result[r.key]=r.value; } });
    res.json(result);
  } catch (e) { next(e); }
});

// Upload de logo (painel ou patrocinador)
router.post('/logo', uploadLogo.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const url = `/storage/logos/${req.file.filename}`;
    const type = req.body.type || 'sponsor'; // 'panel' ou 'sponsor'

    // Se for logo do painel, salvar nas settings
    if (type === 'panel') {
      // Deletar logo anterior se houver
      const old = await db.get("SELECT value FROM settings WHERE key='panel_logo'");
      if (old?.value) {
        const oldPath = path.join(__dirname, '../../', old.value.replace(/^\//, ''));
        await fs.unlink(oldPath).catch(() => {});
      }
      await db.run(
        "INSERT INTO settings (key,value) VALUES ('panel_logo',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [url]
      );
    }

    res.json({ url, filename: req.file.filename, originalName: req.file.originalname, size: req.file.size });
  } catch (e) { next(e); }
});

// Deletar um logo de patrocinador (arquivo físico)
router.delete('/logo/:filename', async (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename); // segurança
    const filePath = path.join(LOGOS_DIR, filename);
    await fs.unlink(filePath).catch(() => {});
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = router;
