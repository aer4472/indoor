const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const fs      = require('fs').promises;
const bcrypt  = require('bcryptjs');

const DB_PATH = path.join(__dirname, '../../storage/database.db');

class Database {
  constructor() { this.db = null; }

  async initialize() {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    await fs.mkdir(path.join(path.dirname(DB_PATH), 'videos'), { recursive: true });
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(DB_PATH, async err => {
        if (err) reject(err);
        else { await this.createTables(); await this.seedAdmin(); resolve(); }
      });
    });
  }

  async createTables() {
    const schema = `
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tvs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        playlist_id TEXT,
        orientation TEXT DEFAULT 'horizontal',
        volume INTEGER DEFAULT 100,
        transition TEXT DEFAULT 'fade',
        last_seen TEXT,
        status TEXT DEFAULT 'offline',
        current_video TEXT,
        playback_time INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS playlist_videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        order_position INTEGER NOT NULL,
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (video_id)    REFERENCES videos(id)    ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        tv_id TEXT NOT NULL,
        playlist_id TEXT NOT NULL,
        name TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tv_id)       REFERENCES tvs(id)       ON DELETE CASCADE,
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS emergency (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active INTEGER DEFAULT 0,
        title TEXT DEFAULT 'AVISO IMPORTANTE',
        message TEXT DEFAULT '',
        bg_color TEXT DEFAULT '#dc2626',
        text_color TEXT DEFAULT '#ffffff',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        position TEXT DEFAULT 'bottom',
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Log de reprodução (o que tocou, quando, em qual TV)
      CREATE TABLE IF NOT EXISTS playback_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tv_id TEXT NOT NULL,
        tv_name TEXT,
        video_name TEXT,
        media_type TEXT,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        duration_sec INTEGER DEFAULT 0
      );

      -- Log de auditoria (quem fez o quê no painel)
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Configurações do sistema (logo, cores, nome do painel)
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_playlist_videos ON playlist_videos(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_tv_playlist     ON tvs(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_tv    ON schedules(tv_id);
      CREATE INDEX IF NOT EXISTS idx_playback_tv     ON playback_log(tv_id);
      CREATE INDEX IF NOT EXISTS idx_playback_date   ON playback_log(started_at);
    `;
    return new Promise((resolve, reject) => {
      this.db.exec(schema, async err => {
        if (err) reject(err);
        else {
          await this.run('INSERT OR IGNORE INTO emergency (id) VALUES (1)');
          // Adicionar colunas novas se já existia banco antigo
          const migrations = [
            'ALTER TABLE users ADD COLUMN role TEXT DEFAULT "admin"',
            'ALTER TABLE tvs ADD COLUMN volume INTEGER DEFAULT 100',
            'ALTER TABLE tvs ADD COLUMN transition TEXT DEFAULT "fade"',
            'ALTER TABLE videos ADD COLUMN config TEXT DEFAULT "{}"',
            'ALTER TABLE videos ADD COLUMN rotation INTEGER DEFAULT 0',
            'ALTER TABLE playlists ADD COLUMN rotation INTEGER DEFAULT 0',
            'ALTER TABLE playlists ADD COLUMN shuffle INTEGER DEFAULT 0',
            'ALTER TABLE widgets ADD COLUMN tv_ids TEXT DEFAULT ""',
            'ALTER TABLE widgets ADD COLUMN rotation INTEGER DEFAULT 0',
            'ALTER TABLE tvs ADD COLUMN pin TEXT',
          ];
          for (const sql of migrations) {
            try { await this.run(sql); } catch {}
          }
          resolve();
        }
      });
    });
  }

  async seedAdmin() {
    const existing = await this.get('SELECT id FROM users WHERE username = ?', ['admin']);
    if (!existing) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'indoor123', 10);
      await this.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', hash, 'admin']);
      console.log('✅ Usuário admin criado (senha: indoor123)');
    }
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  }
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
    });
  }
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
    });
  }
}

module.exports = new Database();
