import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '..', 'mugenbattle.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
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
  `);

  addColumnIfMissing(db, 'fighter', 'author', 'TEXT');
  addColumnIfMissing(db, 'fighter', 'source_url', 'TEXT');
  addColumnIfMissing(db, 'stage', 'author', 'TEXT');
  addColumnIfMissing(db, 'stage', 'source_url', 'TEXT');
  addColumnIfMissing(db, 'fighter', 'validated_at', 'TEXT');
  addColumnIfMissing(db, 'fighter', 'validation_reason', 'TEXT');
  addColumnIfMissing(db, 'tournament', 'format', 'TEXT');
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
