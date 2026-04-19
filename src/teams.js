/**
 * Team management: signup bootstrapping, roster queries, lineup rules.
 *
 * Invariants:
 *  - One team per user (team.UNIQUE(user_id)).
 *  - Active slot count = 5 exactly for league-eligible teams. 0..2 bench, 0..n for_sale
 *    (but for_sale implies the fighter was benched first — moving to for_sale
 *    must leave active at 5, enforced at listing time).
 *  - Master fighters (fighter.is_master=1) are never modified; user changes
 *    live on owned_fighter / owned_fighter_ai.
 */

import { getDb } from './db.js';

const STARTER_MASTER_FILENAME = 'kfm';   // bundled Kung Fu Man
const STARTER_COUNT = 5;

export function findStarterMaster(db) {
  // Prefer the KFM master (stock Ikemen). Fall back to any active master if
  // KFM was removed for some reason — we still want signup to work.
  let row = db
    .prepare("SELECT id FROM fighter WHERE file_name = ? AND is_master = 1 LIMIT 1")
    .get(STARTER_MASTER_FILENAME);
  if (row) return row.id;
  row = db
    .prepare('SELECT id FROM fighter WHERE is_master = 1 AND active = 1 LIMIT 1')
    .get();
  if (!row) throw new Error('No master fighters available for starter team');
  return row.id;
}

/**
 * Create a team for the user and populate 5 starter fighters.
 * Safe to call inside an existing transaction; creates its own otherwise.
 */
export function bootstrapTeamForUser(db, userId, teamName) {
  const existing = db.prepare('SELECT id FROM team WHERE user_id = ?').get(userId);
  if (existing) return existing.id;

  const masterId = findStarterMaster(db);

  const insertTeam = db.prepare(
    'INSERT INTO team (user_id, name) VALUES (?, ?)'
  );
  const insertFighter = db.prepare(
    'INSERT INTO owned_fighter (team_id, master_fighter_id, display_name, slot, priority) VALUES (?, ?, ?, \'active\', ?)'
  );
  const insertHistory = db.prepare(
    'INSERT INTO owned_fighter_team_history (owned_fighter_id, team_id, reason) VALUES (?, ?, ?)'
  );

  const txn = db.transaction(() => {
    const res = insertTeam.run(userId, teamName);
    const teamId = res.lastInsertRowid;
    for (let i = 0; i < STARTER_COUNT; i++) {
      const fighterName = `Fighter ${i + 1}`;
      const fRes = insertFighter.run(teamId, masterId, fighterName, i);
      insertHistory.run(fRes.lastInsertRowid, teamId, 'created');
    }
    return teamId;
  });
  return txn();
}

export function getTeamForUser(db, userId) {
  const team = db.prepare('SELECT * FROM team WHERE user_id = ?').get(userId);
  if (!team) return null;
  const fighters = db
    .prepare(`
      SELECT of.*, f.file_name AS master_file_name, f.display_name AS master_display_name,
        f.author AS master_author
      FROM owned_fighter of
      JOIN fighter f ON of.master_fighter_id = f.id
      WHERE of.team_id = ?
      ORDER BY of.slot, of.priority, of.id
    `)
    .all(team.id);
  return { ...team, fighters };
}

export function getTeamById(db, teamId) {
  const team = db.prepare('SELECT * FROM team WHERE id = ?').get(teamId);
  if (!team) return null;
  const fighters = db
    .prepare(`
      SELECT of.*, f.file_name AS master_file_name, f.display_name AS master_display_name,
        f.author AS master_author
      FROM owned_fighter of
      JOIN fighter f ON of.master_fighter_id = f.id
      WHERE of.team_id = ?
      ORDER BY of.slot, of.priority, of.id
    `)
    .all(teamId);
  return { ...team, fighters };
}
