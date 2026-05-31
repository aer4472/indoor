/**
 * SMARTVISION PRO — Security Middleware
 * Implementa: Rate Limiting, Brute Force Protection,
 * Helmet (headers), HPP, Audit Log, Input Sanitization
 */
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const hpp       = require('hpp');
const db        = require('../database/db');

// ── 1. HELMET — HTTP Security Headers ────────────────────────────
// Protege contra XSS, Clickjacking, MIME sniffing, etc.
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                   "https://unpkg.com","https://cdn.tailwindcss.com",
                   "https://cdnjs.cloudflare.com","https://cdn.socket.io",
                   "https://fonts.googleapis.com","https://www.youtube.com"],
      styleSrc:   ["'self'","'unsafe-inline'","https://fonts.googleapis.com","https://cdn.tailwindcss.com"],
      fontSrc:    ["'self'","https://fonts.gstatic.com"],
      imgSrc:     ["'self'","data:","blob:","https:"],
      mediaSrc:   ["'self'","blob:","https:"],
      frameSrc:   ["'self'","https://www.youtube.com","https://youtube.com"],
      connectSrc: ["'self'","wss:","ws:","https:"],
      workerSrc:  ["'self'","blob:"],
    },
  },
  crossOriginEmbedderPolicy: false, // necessário para YouTube embed
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

// ── 2. RATE LIMITING ──────────────────────────────────────────────

// Global: 300 req/15min por IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' },
  skip: (req) => req.path === '/api/health',
});

// Login: 10 tentativas/15min → brute force protection
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' },
  keyGenerator: (req) => req.ip + ':' + (req.body?.username || ''),
});

// Upload: 20 uploads/hora
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Limite de uploads atingido. Tente novamente em 1 hora.' },
});

// API geral autenticada: 500 req/15min
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Limite de API atingido.' },
});

// ── 3. HPP — HTTP Parameter Pollution ────────────────────────────
const hppMiddleware = hpp();

// ── 4. INPUT SANITIZATION ─────────────────────────────────────────
function sanitizeInput(req, res, next) {
  // Remove null bytes (directory traversal / injection)
  const sanitize = (obj) => {
    if (typeof obj === 'string') {
      return obj
        .replace(/\0/g, '')           // null bytes
        .replace(/\.\.\//g, '')       // path traversal
        .replace(/\.\.\\/, '');       // windows path traversal
    }
    if (typeof obj === 'object' && obj !== null) {
      for (const key of Object.keys(obj)) {
        obj[key] = sanitize(obj[key]);
      }
    }
    return obj;
  };
  if (req.body)   req.body   = sanitize(req.body);
  if (req.query)  req.query  = sanitize(req.query);
  if (req.params) req.params = sanitize(req.params);
  next();
}

// ── 5. SECURITY HEADERS extras ────────────────────────────────────
function extraHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Remove server fingerprint
  res.removeHeader('X-Powered-By');
  next();
}

// ── 6. AUDIT LOG ──────────────────────────────────────────────────
async function auditLog(userId, username, action, target, detail, req) {
  try {
    const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
              || req?.connection?.remoteAddress
              || req?.ip
              || 'unknown';
    const ua = req?.headers?.['user-agent']?.slice(0, 200) || 'unknown';
    await db.run(
      `INSERT INTO audit_log ("user", action, target, detail, ip, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [username || userId || 'system', action, target || null, detail || null, ip, ua]
    );
  } catch(e) {
    // Never fail the request due to audit log errors
    console.error('Audit log error:', e.message);
  }
}

// ── 7. FILE VALIDATION ────────────────────────────────────────────
const SAFE_EXTENSIONS = new Set([
  '.mp4','.webm','.mov','.avi','.mkv',
  '.mp3','.wav','.ogg','.aac','.flac','.m4a',
  '.jpg','.jpeg','.png','.webp','.gif',
  '.pdf'
]);

const MIME_EXTENSION_MAP = {
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
  'video/x-msvideo': ['.avi'],
  'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'],
  'audio/ogg': ['.ogg'],
  'audio/aac': ['.aac'],
  'image/jpeg': ['.jpg','.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'application/pdf': ['.pdf'],
};

function validateFileUpload(req, res, next) {
  if (!req.file) return next();
  const ext  = require('path').extname(req.file.originalname).toLowerCase();
  const mime = req.file.mimetype;

  // Check extension is safe
  if (!SAFE_EXTENSIONS.has(ext)) {
    require('fs').promises.unlink(req.file.path).catch(()=>{});
    return res.status(400).json({ error: `Extensão não permitida: ${ext}` });
  }

  // Check MIME matches extension (prevents MIME confusion attacks)
  const allowedExts = MIME_EXTENSION_MAP[mime] || [];
  if (allowedExts.length && !allowedExts.includes(ext)) {
    require('fs').promises.unlink(req.file.path).catch(()=>{});
    return res.status(400).json({ error: 'Tipo de arquivo inconsistente com a extensão.' });
  }

  // Check for double extensions (e.g., file.php.jpg)
  const dangerousExtensions = /\.(php|php3|php4|php5|phtml|asp|aspx|js|jsx|ts|sh|bash|py|rb|pl|exe|bat|cmd|ps1)/i;
  if (dangerousExtensions.test(req.file.originalname)) {
    require('fs').promises.unlink(req.file.path).catch(()=>{});
    return res.status(400).json({ error: 'Nome de arquivo suspeito rejeitado.' });
  }

  next();
}

// ── 8. ADMIN-ONLY MIDDLEWARE ──────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  }
  next();
}

// ── 9. CORS RESTRITO ──────────────────────────────────────────────
// Retorna configuração CORS segura
function buildCors() {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['*'];

  return require('cors')({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origem não permitida pelo CORS'));
      }
    },
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization'],
    credentials: true,
    maxAge: 86400,
  });
}

module.exports = {
  helmetMiddleware,
  globalLimiter,
  loginLimiter,
  uploadLimiter,
  apiLimiter,
  hppMiddleware,
  sanitizeInput,
  extraHeaders,
  auditLog,
  validateFileUpload,
  adminOnly,
  buildCors,
};
