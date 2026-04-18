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
  `);

  addColumnIfMissing(db, 'fighter', 'author', 'TEXT');
  addColumnIfMissing(db, 'fighter', 'source_url', 'TEXT');
  addColumnIfMissing(db, 'stage', 'author', 'TEXT');
  addColumnIfMissing(db, 'stage', 'source_url', 'TEXT');
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
