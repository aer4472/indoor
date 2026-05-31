// src/middleware/tenant.js
// Determina se o usuário é admin master (vê tudo) ou usuário comum (vê só os seus)
function tenantFilter(req) {
  const isAdmin = req.user?.role === 'admin';
  const userId  = req.user?.id;
  return { isAdmin, userId };
}
module.exports = { tenantFilter };
