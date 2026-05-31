/**
 * SMARTVISION PRO — App Entry
 * Security: Helmet, Rate Limiting, HPP, Input Sanitization, CORS restrito
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');

const {
  helmetMiddleware,
  globalLimiter,
  apiLimiter,
  hppMiddleware,
  sanitizeInput,
  extraHeaders,
  buildCors,
} = require('./middleware/security');

const { authMiddleware } = require('./middleware/auth');

const app = express();

// ── Garantir storage dirs ──────────────────────────────────────────
['storage/videos','storage/logos'].forEach(dir => {
  fs.mkdirSync(path.join(__dirname, '..', dir), { recursive: true });
});

// ── Security middleware stack (ordem importa) ─────────────────────
app.set('trust proxy', 1);          // Render/Heroku proxy
app.disable('x-powered-by');        // Remove fingerprint
app.use(helmetMiddleware);          // HTTP security headers
app.use(extraHeaders);              // Extra security headers
app.use(buildCors());               // CORS restrito
app.use(hppMiddleware);             // HTTP Parameter Pollution
app.use(globalLimiter);             // Global rate limiting

// ── Body parsing ──────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));           // Limit payload size
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(sanitizeInput);             // Input sanitization

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
}));
app.use('/storage/videos', express.static(path.join(__dirname, '../storage/videos')));
app.use('/storage/logos',  express.static(path.join(__dirname, '../storage/logos')));

// ── Public routes ─────────────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/player',  require('./routes/player'));
app.use('/api/proxy',   require('./routes/proxy'));
app.use('/api/ytstream',require('./routes/ytstream'));

// ── Protected routes (auth required) ─────────────────────────────
app.use('/api/settings',  authMiddleware, apiLimiter, require('./routes/settings'));
app.use('/api/backup',    authMiddleware, apiLimiter, require('./routes/backup'));
app.use('/api/files',     authMiddleware, apiLimiter, require('./routes/filebrowser'));
app.use('/api/sponsors',  authMiddleware, apiLimiter, require('./routes/sponsors'));
app.use('/api/tvs',       authMiddleware, apiLimiter, require('./routes/tvs').router);
app.use('/api/playlists', authMiddleware, apiLimiter, require('./routes/PlayLists').router);
app.use('/api/videos',    authMiddleware, apiLimiter, require('./routes/videos'));
app.use('/api/schedules', authMiddleware, apiLimiter, require('./routes/schedules'));
app.use('/api/emergency', authMiddleware, apiLimiter, require('./routes/emergency'));
app.use('/api/widgets',   authMiddleware, apiLimiter, require('./routes/widgets'));
app.use('/api/users',     authMiddleware, apiLimiter, require('./routes/users'));
app.use('/api/plans',     authMiddleware, apiLimiter, require('./routes/plans'));
app.use('/api/reports',   authMiddleware, apiLimiter, require('./routes/reports'));

// ── Health check ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '4.1', timestamp: new Date().toISOString() });
});

// ── 404 handler ───────────────────────────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

// ── Global error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  // Never leak stack traces in production
  const isDev = process.env.NODE_ENV === 'development';
  console.error(`[ERROR] ${err.status || 500} ${req.method} ${req.path} —`, err.message);

  res.status(err.status || 500).json({
    error: isDev ? err.message : 'Erro interno do servidor',
    ...(isDev && { stack: err.stack }),
  });
});

module.exports = app;
