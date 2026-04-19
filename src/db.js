import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from './migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(__dirname, '..', 'mugenbattle.db');

let db;

/**
 * Resolve the DB location. `MB_DB_PATH` overrides the bundled file so
 * tests can point at /tmp/mb-test-*.db or ":memory:". Bare ":memory:"
 * is treated as a special sentinel for better-sqlite3.
 */
function resolveDbPath() {
  const env = process.env.MB_DB_PATH;
  if (!env) return DEFAULT_DB_PATH;
  if (env === ':memory:') return ':memory:';
  return env;
}

export function getDb() {
  if (!db) {
    const path = resolveDbPath();
    db = new Database(path);
    // WAL isn't supported on :memory: — skip.
    if (path !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
    runMigrations(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fighter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      matches_won INTEGER DEFAULT 0,
      matches_lost INTEGER DEFAULT 0,
      matches_drawn INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      times_used INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fight_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fighter_one_id INTEGER NOT NULL REFERENCES fighter(id),
      fighter_two_id INTEGER NOT NULL REFERENCES fighter(id),
      stage_id INTEGER NOT NULL REFERENCES stage(id),
      victor_id INTEGER REFERENCES fighter(id),
      fought_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tournament (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      size INTEGER NOT NULL,
      selection TEXT DEFAULT 'random',
      seeding TEXT DEFAULT 'random',
      status TEXT DEFAULT 'running',
      winner_id INTEGER REFERENCES fighter(id),
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tournament_match (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      match_index INTEGER NOT NULL,
      fighter_one_id INTEGER REFERENCES fighter(id),
      fighter_two_id INTEGER REFERENCES fighter(id),
      victor_id INTEGER REFERENCES fighter(id),
      stage_id INTEGER REFERENCES stage(id),
      fought_at TEXT,
      UNIQUE(tournament_id, round, match_index)
    );

    CREATE TABLE IF NOT EXISTS user_account (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_code (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_auth_code_email ON auth_code(email);
  `);

  addColumnIfMissing(db, 'fighter', 'author', 'TEXT');
  addColumnIfMissing(db, 'fighter', 'source_url', 'TEXT');
  addColumnIfMissing(db, 'stage', 'author', 'TEXT');
  addColumnIfMissing(db, 'stage', 'source_url', 'TEXT');
  addColumnIfMissing(db, 'fighter', 'validated_at', 'TEXT');
  addColumnIfMissing(db, 'fighter', 'validation_reason', 'TEXT');
  addColumnIfMissing(db, 'tournament', 'format', 'TEXT');
  addColumnIfMissing(db, 'user_account', 'username', 'TEXT');
  // Case-insensitive unique index. Uses a partial index so old rows with NULL
  // usernames (users mid-onboarding) don't collide.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_username
    ON user_account (lower(username))
    WHERE username IS NOT NULL;
  `);
}

function addColumnIfMissing(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
