const http  = require('http');
const { Server } = require('socket.io');
const cron  = require('node-cron');
const app   = require('./src/app');
const db    = require('./src/database/db');
const broadcast = require('./src/broadcast');

const PORT   = process.env.PORT || 9090;
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin:'*', methods:['GET','POST'] } });

// Injetar io no módulo broadcast (único ponto)
broadcast.setIO(io);

// Injetar io nas rotas que precisam (emergency usa io direto)
[
  require('./src/routes/tvs').router,
  require('./src/routes/PlayLists').router,
  require('./src/routes/player'),
  require('./src/routes/emergency'),
  require('./src/routes/schedules'),
  require('./src/routes/widgets'),
  require('./src/routes/videos'),
].forEach(r => r.setIO && r.setIO(io));

// Conexões WebSocket
io.on('connection', (socket) => {
  socket.on('join-admin', () => {
    socket.join('admin-panel');
    console.log(`🖥 Admin conectado (${socket.id})`);
  });
  socket.on('join-tv', (tvId) => {
    socket.join(`tv-${tvId}`);
    console.log(`📺 TV ${tvId} conectada (${socket.id})`);
  });
  socket.on('disconnect', () => {
    console.log(`🔌 Socket desconectado (${socket.id})`);
  });
});

// Verificar trials e assinaturas vencidas — roda a cada hora
cron.schedule('0 * * * *', async () => {
  try {
    // Marcar trials vencidos
    const expiredTrials = await db.run(
      `UPDATE users SET account_status = 'expired'
       WHERE account_status = 'trial'
         AND trial_ends_at IS NOT NULL
         AND trial_ends_at < NOW()`,
      []
    );
    // Marcar assinaturas vencidas
    const expiredSubs = await db.run(
      `UPDATE users SET account_status = 'expired'
       WHERE account_status = 'active'
         AND subscription_ends_at IS NOT NULL
         AND subscription_ends_at < NOW()
         AND role != 'admin'`,
      []
    );
    if ((expiredTrials.changes || 0) + (expiredSubs.changes || 0) > 0) {
      console.log(`⏰ Contas expiradas: ${expiredTrials.changes || 0} trials, ${expiredSubs.changes || 0} assinaturas`);
    }
  } catch(e) {
    console.error('Cron expiration error:', e.message);
  }
});

// Detectar TVs offline a cada 2 min
cron.schedule('*/2 * * * *', async () => {
  const threshold = new Date(Date.now() - 3*60*1000).toISOString();
  const r = await db.run(
    `UPDATE tvs SET status='offline' WHERE status='online' AND (last_seen IS NULL OR last_seen < ?)`,
    [threshold]
  );
  if (r.changes > 0) broadcast.toAdmin('tvs-status-changed', { timestamp:new Date().toISOString() });
});

db.initialize().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    let ip = 'localhost';
    Object.values(os.networkInterfaces()).flat().forEach(i => {
      if (i.family==='IPv4' && !i.internal) ip = i.address;
    });
    console.log(`
╔══════════════════════════════════════════════════════╗
║       📺  INDOOR TV SERVER v1.0 — ONLINE             ║
╠══════════════════════════════════════════════════════╣
║  🌐 Rede:   http://${ip}:${PORT}
║  🔐 Login:  admin / indoor123                        ║
║  ⚡ Push:   Atualização automática nas TVs           ║
╚══════════════════════════════════════════════════════╝`);
  });
}).catch(err => { console.error('❌ Erro:', err); process.exit(1); });
