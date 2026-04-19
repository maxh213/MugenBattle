/**
 * Tiny numbered-migrations runner. Reads src/migrations/*.sql in lexicographic
 * order, applies any not in schema_migrations, records each as applied.
 *
 * Idempotent: already-applied migrations are skipped. Each file is its own
 * transaction — failure rolls back cleanly.
 *
 * Migration files must be named `NNN_description.sql` (e.g. `001_users.sql`).
 * Comments starting with `--` are fine. Multi-statement files are fine —
 * SQLite executes them as a block via db.exec().
 */

import { readdirSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, 'migrations');

export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  let files;
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    return; // no migrations dir = nothing to run
  }

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    });
    try {
      tx();
      if (process.env.MB_QUIET !== '1') console.log(`[migrate] applied ${file}`);
    } catch (e) {
      throw new Error(`[migrate] ${file} failed: ${e.message}`);
    }
  }
}
