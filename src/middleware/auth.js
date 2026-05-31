/**
 * SMARTVISION PRO — Auth Middleware
 * JWT verification com proteção contra algorithm confusion
 */
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET não configurado! Use uma variável de ambiente segura.');
}
const SECRET = JWT_SECRET || 'svp-default-secret-CHANGE-IN-PRODUCTION-2024!';

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  try {
    // Força algoritmo HS256 — previne algorithm confusion attacks
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// Middleware opcional — não bloqueia se não autenticado
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try {
      req.user = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    } catch(_) {}
  }
  next();
}

module.exports = { authMiddleware, optionalAuth, JWT_SECRET: SECRET };
