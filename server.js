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
  require('./src/routes/tvs'),
  require('./src/routes/PlayLists'),
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
