// Módulo central de notificação WebSocket
let _io = null;

const broadcast = {
  setIO: (io) => { _io = io; },

  // Re-sincronizar conteúdo sem recarregar página
  contentChanged: (tvId = null, reason = 'update') => {
    if (!_io) return;
    const payload = { reason, timestamp: new Date().toISOString() };
    if (tvId) {
      _io.to(`tv-${tvId}`).emit('content-changed', payload);
    } else {
      _io.emit('content-changed', payload);
    }
    console.log(`📡 content-changed → ${tvId||'ALL'} (${reason})`);
  },

  // Forçar reload completo do browser
  forceReload: (tvId = null) => {
    if (!_io) return;
    const payload = { timestamp: new Date().toISOString() };
    if (tvId) {
      _io.to(`tv-${tvId}`).emit('force-reload', payload);
      console.log(`🔄 force-reload → tv-${tvId}`);
    } else {
      _io.emit('force-reload', payload);
      console.log(`🔄 force-reload → ALL TVs`);
    }
  },

  // Notificar painel admin
  toAdmin: (event, data) => {
    if (!_io) return;
    _io.to('admin-panel').emit(event, data);
  },

  // Notificar TVs afetadas por mudança em playlist
  playlistChanged: async (playlistId, db) => {
    if (!_io || !db) return;
    // TVs com esta playlist como padrão
    const tvs = await db.all('SELECT id FROM tvs WHERE playlist_id=?', [playlistId]);
    // TVs com agendamento ativo usando esta playlist
    const scheds = await db.all('SELECT DISTINCT tv_id FROM schedules WHERE playlist_id=? AND active=1', [playlistId]);
    const affected = new Set([...tvs.map(t=>t.id), ...scheds.map(s=>s.tv_id)]);
    affected.forEach(tvId => {
      _io.to(`tv-${tvId}`).emit('content-changed', { reason:'playlist', playlistId });
    });
    if (affected.size > 0) console.log(`📡 playlist-changed → ${[...affected].join(', ')}`);
  },
};

module.exports = broadcast;
