const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('PostgreSQL pool error:', err));

class Database {
  async initialize() {
    console.log('🐘 Conectando ao PostgreSQL (Supabase)...');
    await this.createTables();
    await this.runMigrations();
    await this.seedAdmin();
    console.log('✅ Banco de dados pronto!');
  }

  async createTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tvs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        playlist_id TEXT,
        orientation TEXT DEFAULT 'horizontal',
        volume INTEGER DEFAULT 100,
        transition TEXT DEFAULT 'fade',
        last_seen TIMESTAMPTZ,
        status TEXT DEFAULT 'offline',
        current_video TEXT,
        playback_time INTEGER DEFAULT 0,
        pin TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        rotation INTEGER DEFAULT 0,
        shuffle INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        duration INTEGER,
        display_duration INTEGER DEFAULT 10,
        size INTEGER,
        mime_type TEXT,
        media_type TEXT DEFAULT 'video',
        config TEXT DEFAULT '{}',
        rotation INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS playlist_videos (
        id SERIAL PRIMARY KEY,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        order_position INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        tv_id TEXT NOT NULL REFERENCES tvs(id) ON DELETE CASCADE,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
        active INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS emergency (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        active INTEGER DEFAULT 0,
        title TEXT DEFAULT 'AVISO IMPORTANTE',
        message TEXT DEFAULT '',
        bg_color TEXT DEFAULT '#dc2626',
        text_color TEXT DEFAULT '#ffffff',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        position TEXT DEFAULT 'bottom',
        active INTEGER DEFAULT 1,
        tv_ids TEXT DEFAULT '',
        rotation INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS playback_log (
        id SERIAL PRIMARY KEY,
        tv_id TEXT NOT NULL,
        tv_name TEXT,
        video_name TEXT,
        media_type TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        duration_sec INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        "user" TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_playlist_videos ON playlist_videos(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_tv_playlist     ON tvs(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_tv    ON schedules(tv_id);
      CREATE INDEX IF NOT EXISTS idx_playback_tv     ON playback_log(tv_id);
      CREATE INDEX IF NOT EXISTS idx_playback_date   ON playback_log(started_at);
    `);

    // Garante linha única de emergency
    await pool.query(`INSERT INTO emergency (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  }

  async runMigrations() {
    // Gera PIN para TVs sem PIN
    const { rows } = await pool.query(`SELECT id FROM tvs WHERE pin IS NULL OR pin = ''`);
    for (const tv of rows) {
      const pin = Math.floor(100000 + Math.random() * 900000).toString();
      await pool.query('UPDATE tvs SET pin = $1 WHERE id = $2', [pin, tv.id]);
      console.log(`🔑 PIN gerado para TV ${tv.id}: ${pin}`);
    }
  }

  async seedAdmin() {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
    if (rows.length === 0) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'indoor123', 10);
      await pool.query(
        'INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
        ['admin', hash, 'admin']
      );
      console.log('✅ Usuário admin criado (senha: indoor123)');
    }
  }

  // ── Métodos compatíveis com a interface SQLite anterior ──────────

  async run(sql, params = []) {
    // Converte placeholders SQLite (?) para PostgreSQL ($1, $2...)
    const pgSql = this._convertPlaceholders(sql);
    const result = await pool.query(pgSql, params);
    // Support RETURNING clause — return first row's id if available
    const firstRow = result.rows[0];
    return {
      id: firstRow?.id ?? null,
      changes: result.rowCount,
      row: firstRow || null,
    };
  }

  async get(sql, params = []) {
    const pgSql = this._convertPlaceholders(sql);
    const result = await pool.query(pgSql, params);
    return result.rows[0] || null;
  }

  async all(sql, params = []) {
    const pgSql = this._convertPlaceholders(sql);
    const result = await pool.query(pgSql, params);
    return result.rows;
  }

  // Converte ? para $1, $2, $3...
  _convertPlaceholders(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }
}

module.exports = new Database();
