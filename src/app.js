const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { authMiddleware } = require('./middleware/auth');

const app = express();

// Garantir que diretórios de storage existem
['storage/videos','storage/logos'].forEach(dir => {
  fs.mkdirSync(path.join(__dirname, '..', dir), { recursive: true });
});
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sem cache para arquivos estáticos
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, '../public')));
app.use('/storage/videos', express.static(path.join(__dirname, '../storage/videos')));
app.use('/storage/logos',  express.static(path.join(__dirname, '../storage/logos')));

// ── Públicas ──────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/player',   require('./routes/player'));
app.use('/api/proxy',    require('./routes/proxy'));
app.use('/api/ytstream',  require('./routes/ytstream'));
app.use('/api/files',     authMiddleware, require('./routes/filebrowser'));
app.use('/api/sponsors',  authMiddleware, require('./routes/sponsors')); // navegar pasta do servidor
app.use('/api/settings', require('./middleware/auth').authMiddleware, require('./routes/settings'));
app.use('/api/backup',  require('./middleware/auth').authMiddleware, require('./routes/backup'));

// ── Protegidas ────────────────────────────────────────────────────
app.use('/api/tvs',       authMiddleware, require('./routes/tvs').router);
app.use('/api/playlists', authMiddleware, require('./routes/PlayLists').router);
app.use('/api/videos',    authMiddleware, require('./routes/videos'));
app.use('/api/schedules', authMiddleware, require('./routes/schedules'));
app.use('/api/emergency', authMiddleware, require('./routes/emergency'));
app.use('/api/widgets',   authMiddleware, require('./routes/widgets'));
app.use('/api/users',     authMiddleware, require('./routes/users'));
app.use('/api/plans',     authMiddleware, require('./routes/plans'));
app.use('/api/reports',   authMiddleware, require('./routes/reports'));

app.get('/api/health', (req, res) => res.json({ status:'ok', version:'4.0', timestamp:new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status||500).json({ error: err.message||'Erro interno' });
});

module.exports = app;
