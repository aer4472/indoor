const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');

const AUDIO_EXT = ['.mp3','.wav','.ogg','.aac','.flac','.m4a','.wma'];

// ── GET /api/files/drives ─────────────────────────────────────────
router.get('/drives', (req, res) => {
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic logicaldisk get name', { encoding:'utf8', shell:true });
      const drives = out.split('\n')
        .map(l => l.trim())
        .filter(l => /^[A-Z]:$/.test(l))
        .map(d => ({ path: d + '\\', label: d }));
      return res.json({ drives });
    }
    return res.json({ drives: [{ path:'/', label:'/' }] });
  } catch(e) {
    res.json({ drives: [{ path: process.platform==='win32'?'C:\\':'/home', label:'Home' }] });
  }
});

// ── GET /api/files/ls ─────────────────────────────────────────────
router.get('/ls', (req, res) => {
  const dir = req.query.path || (process.platform==='win32' ? 'C:\\' : '/');
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const folders = [];
    const audios  = [];

    for (const e of entries) {
      try {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')) {
          // Contar áudios recursivamente (máx 2 níveis para ser rápido)
          const count = countAudiosInDir(full, 2);
          folders.push({ name: e.name, path: full, type: 'folder', audioCount: count });
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (AUDIO_EXT.includes(ext)) {
            const stat = fs.statSync(full);
            audios.push({ name: e.name, path: full, type: 'audio', size: stat.size });
          }
        }
      } catch {}
    }

    folders.sort((a,b) => a.name.localeCompare(b.name));
    audios.sort((a,b)  => a.name.localeCompare(b.name));

    const parent = path.dirname(dir);
    res.json({ path: dir, parent: parent !== dir ? parent : null, folders, audios });
  } catch(e) {
    res.status(400).json({ error: 'Pasta não acessível: ' + e.message });
  }
});

// Conta arquivos de áudio numa pasta recursivamente (limitado por profundidade)
function countAudiosInDir(dir, depth) {
  if (depth < 0) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      try {
        if (e.isFile() && AUDIO_EXT.includes(path.extname(e.name).toLowerCase())) {
          count++;
        } else if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')) {
          count += countAudiosInDir(path.join(dir, e.name), depth - 1);
        }
      } catch {}
    }
  } catch {}
  return count;
}

// Lista TODOS os áudios numa pasta recursivamente
function collectAudios(dir, results = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      try {
        const full = path.join(dir, e.name);
        if (e.isFile() && AUDIO_EXT.includes(path.extname(e.name).toLowerCase())) {
          const stat = fs.statSync(full);
          results.push({ name: e.name, path: full, size: stat.size });
        } else if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')) {
          collectAudios(full, results);
        }
      } catch {}
    }
  } catch {}
  return results;
}

// ── GET /api/files/scan?path=... ──────────────────────────────────
// Retorna todos os áudios dentro de uma pasta (recursivo)
router.get('/scan', (req, res) => {
  const dir = req.query.path;
  if (!dir) return res.status(400).json({ error: 'path obrigatório' });
  const audios = collectAudios(dir);
  res.json({ path: dir, audios });
});

// ── POST /api/files/import ────────────────────────────────────────
// Copia arquivos de áudio para o storage do sistema
router.post('/import', async (req, res) => {
  const { files } = req.body;
  if (!files || !files.length) return res.status(400).json({ error: 'Nenhum arquivo' });

  const storageDir = path.join(__dirname, '../../storage/videos');
  fs.mkdirSync(storageDir, { recursive: true });

  const mimeMap = {
    '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg',
    '.aac':'audio/aac','.flac':'audio/flac','.m4a':'audio/x-m4a','.wma':'audio/x-ms-wma'
  };

  const results = [];
  for (const f of files) {
    try {
      const ext  = path.extname(f.path).toLowerCase();
      const id   = 'audio-' + uuidv4().substring(0, 8);
      const dest = path.join(storageDir, id + ext);
      fs.copyFileSync(f.path, dest);
      const stat = fs.statSync(dest);
      await db.run(
        `INSERT INTO videos (id, filename, original_name, duration, display_duration, size, mime_type, media_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, id + ext, f.name || path.basename(f.path), null, 180, stat.size, mimeMap[ext]||'audio/mpeg', 'audio']
      );
      results.push({ id, name: f.name || path.basename(f.path), ok: true });
    } catch(e) {
      results.push({ path: f.path, ok: false, error: e.message });
    }
  }
  res.json({ imported: results.filter(r=>r.ok).length, results });
});

module.exports = router;
