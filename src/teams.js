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
import {
  readEffectiveStamina,
  LOW_STAMINA_ROTATION_THRESHOLD,
} from './stamina.js';
import { drawStarterMasters, getKfmId } from './market.js';

const STARTER_UNCLAIMED_COUNT = 4;
const STARTER_TOTAL = 5;

/**
 * Create a team for the user and populate 5 starter fighters.
 *   - 4 slots drawn from unclaimed 0-win masters (KFM padding if pool dry).
 *   - 1 KFM training-dummy slot (non-unique, always available).
 * Display names default to the master's display_name; KFM slot is labelled
 * "Training Dummy" to distinguish it in the lineup.
 */
export function bootstrapTeamForUser(db, userId, teamName) {
  const existing = db.prepare('SELECT id FROM team WHERE user_id = ?').get(userId);
  if (existing) return existing.id;

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
    const teamId = insertTeam.run(userId, teamName).lastInsertRowid;
    const masters = drawStarterMasters(db, STARTER_UNCLAIMED_COUNT);
    const kfmId = getKfmId(db);

    for (let i = 0; i < STARTER_UNCLAIMED_COUNT; i++) {
      const m = masters[i];
      const name = m.display_name || m.file_name;
      const fId = insertFighter.run(teamId, m.id, name, i).lastInsertRowid;
      insertHistory.run(fId, teamId, 'created');
    }
    const dummyId = insertFighter.run(teamId, kfmId, 'Training Dummy', STARTER_TOTAL - 1).lastInsertRowid;
    insertHistory.run(dummyId, teamId, 'created');
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

/**
 * Rewrite a team's lineup. Enforces: exactly 5 active, 0..2 bench, at most 1
 * for_sale (stays as-is if present), priority numbers distinct within active,
 * and every id belongs to the team.
 *
 * Body: { active: [id*5], bench: [id*0..2], priority: {id: n}, auto_rotate: bool }
 * Anything in slot='for_sale' stays in place; the caller doesn't mention those.
 */
export function setLineup(db, teamId, body) {
  const active = Array.isArray(body.active) ? body.active.map(Number) : [];
  const bench = Array.isArray(body.bench) ? body.bench.map(Number) : [];
  const priority = body.priority && typeof body.priority === 'object' ? body.priority : {};
  const autoRotate = body.auto_rotate ? 1 : 0;

  if (active.length !== 5) {
    return { status: 400, body: { error: 'Lineup must have exactly 5 active fighters' } };
  }
  if (bench.length > 2) {
    return { status: 400, body: { error: 'At most 2 bench fighters allowed' } };
  }
  if (new Set([...active, ...bench]).size !== active.length + bench.length) {
    return { status: 400, body: { error: 'Duplicate IDs across active/bench' } };
  }

  const teamFighters = db
    .prepare('SELECT id, slot FROM owned_fighter WHERE team_id = ?')
    .all(teamId);
  const byId = new Map(teamFighters.map((f) => [f.id, f]));

  const referenced = [...active, ...bench];
  for (const id of referenced) {
    const f = byId.get(id);
    if (!f) return { status: 400, body: { error: `Fighter ${id} isn't on this team` } };
    if (f.slot === 'for_sale') {
      return { status: 400, body: { error: `Fighter ${id} is listed for sale and can't be assigned` } };
    }
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE team SET auto_rotate = ? WHERE id = ?').run(autoRotate, teamId);
    const setActive = db.prepare(
      "UPDATE owned_fighter SET slot = 'active', priority = ? WHERE id = ? AND team_id = ?"
    );
    const setBench = db.prepare(
      "UPDATE owned_fighter SET slot = 'bench' WHERE id = ? AND team_id = ?"
    );
    active.forEach((id, idx) => setActive.run(priority[id] ?? idx, id, teamId));
    bench.forEach((id) => setBench.run(id, teamId));
  });
  tx();

  return { status: 200, body: { ok: true } };
}

/**
 * Pick 5 fighters to field for a fixture. Starts from active roster ordered by
 * priority; if the team has auto_rotate=1, swap any active fighter whose
 * effective stamina is below the threshold for a bench fighter whose stamina
 * is above it, preferring the highest-stamina bench fighter.
 *
 * Returns null if the team can't field 5 eligible fighters.
 */
export function selectLineup(db, teamId) {
  const team = db.prepare('SELECT auto_rotate FROM team WHERE id = ?').get(teamId);
  if (!team) return null;
  const actives = db
    .prepare("SELECT * FROM owned_fighter WHERE team_id = ? AND slot = 'active' ORDER BY priority, id")
    .all(teamId);
  if (actives.length < 5) return null;

  if (!team.auto_rotate) return actives.slice(0, 5);

  const enriched = actives.map((f) => ({ ...f, eff: readEffectiveStamina(db, f.id) }));
  const tired = enriched.filter((f) => f.eff < LOW_STAMINA_ROTATION_THRESHOLD);
  if (tired.length === 0) return enriched.slice(0, 5);

  const bench = db
    .prepare("SELECT * FROM owned_fighter WHERE team_id = ? AND slot = 'bench'")
    .all(teamId)
    .map((f) => ({ ...f, eff: readEffectiveStamina(db, f.id) }))
    .filter((f) => f.eff >= LOW_STAMINA_ROTATION_THRESHOLD)
    .sort((a, b) => b.eff - a.eff);

  const finalLineup = [...enriched];
  for (const swap of tired) {
    if (bench.length === 0) break;
    const in_ = bench.shift();
    const idx = finalLineup.findIndex((f) => f.id === swap.id);
    finalLineup[idx] = in_;
  }
  return finalLineup.slice(0, 5);
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
