/**
 * SMARTVISION PRO — Subscription & Trial Middleware
 * Bloqueia acesso de contas suspensas, expiradas ou com trial vencido
 */
const db = require('../database/db');

// Verifica se a conta está ativa antes de processar qualquer request protegido
async function checkSubscription(req, res, next) {
  // Admin nunca é bloqueado
  if (req.user?.role === 'admin') return next();
  if (!req.user?.id) return next();

  try {
    const user = await db.get(
      'SELECT account_status, trial_ends_at, subscription_ends_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

    const now = new Date();

    // Conta suspensa pelo admin
    if (user.account_status === 'suspended') {
      return res.status(403).json({
        error: 'Conta suspensa',
        code: 'ACCOUNT_SUSPENDED',
        message: 'Sua conta foi suspensa. Entre em contato com o administrador para regularizar.'
      });
    }

    // Trial vencido
    if (user.account_status === 'trial' && user.trial_ends_at) {
      if (new Date(user.trial_ends_at) < now) {
        await db.run("UPDATE users SET account_status = 'expired' WHERE id = $1", [req.user.id]);
        return res.status(403).json({
          error: 'Período de teste encerrado',
          code: 'TRIAL_EXPIRED',
          message: 'Seu teste gratuito de 3 dias expirou. Contrate um plano para continuar.'
        });
      }
    }

    // Assinatura vencida
    if (user.account_status === 'expired') {
      return res.status(403).json({
        error: 'Assinatura vencida',
        code: 'SUBSCRIPTION_EXPIRED',
        message: 'Sua assinatura está vencida. Renove seu plano para continuar usando o sistema.'
      });
    }

    // Assinatura ativa mas com data de vencimento passou
    if (user.account_status === 'active' && user.subscription_ends_at) {
      if (new Date(user.subscription_ends_at) < now) {
        await db.run("UPDATE users SET account_status = 'expired' WHERE id = $1", [req.user.id]);
        return res.status(403).json({
          error: 'Assinatura vencida',
          code: 'SUBSCRIPTION_EXPIRED',
          message: 'Sua assinatura venceu. Renove para continuar.'
        });
      }
    }

    next();
  } catch(e) {
    console.error('checkSubscription error:', e.message);
    next(); // fail open — não bloqueia por erro interno
  }
}

// Retorna dias restantes (trial ou assinatura)
function getDaysRemaining(user) {
  if (!user) return null;
  const now = new Date();

  if (user.account_status === 'trial' && user.trial_ends_at) {
    const diff = new Date(user.trial_ends_at) - now;
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }
  if (user.subscription_ends_at) {
    const diff = new Date(user.subscription_ends_at) - now;
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }
  return null;
}

module.exports = { checkSubscription, getDaysRemaining };
