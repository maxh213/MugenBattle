/**
 * Stamina model for owned fighters. Event-driven:
 *   - Fielded fighter loses MATCH_COST per fixture.
 *   - Every OTHER non-retired roster fighter on the same team gains
 *     REST_RECOVERY per fixture (they rested while a teammate played).
 *   - Bounded to [0.0, 1.0]; stored directly on owned_fighter.stamina.
 *
 * No time-based recovery anymore — stamina only moves on fixture events,
 * which makes the rotation rules predictable and testable.
 *
 * Life mapping: 1.0 stamina → FULL_LIFE, 0.0 → MIN_LIFE, linear between.
 * Floor chosen so a 0-stamina fighter is weak but not unusable.
 */

export const MATCH_COST = 0.20;
export const REST_RECOVERY = 0.25;
export const FULL_LIFE = 1000;
export const MIN_LIFE = 400;
export const LOW_STAMINA_ROTATION_THRESHOLD = 0.85;

/** Return stored stamina, bounded and coerced. */
export function getEffectiveStamina({ stamina }) {
  const stored = Number(stamina);
  if (!Number.isFinite(stored)) return 1.0;
  return Math.min(1.0, Math.max(0.0, stored));
}

/** Convert 0..1 stamina to an absolute starting life value for Ikemen. */
export function staminaToLife(effStamina) {
  const clamped = Math.min(1.0, Math.max(0.0, effStamina));
  return Math.round(MIN_LIFE + (FULL_LIFE - MIN_LIFE) * clamped);
}

/**
 * Subtract MATCH_COST from a fighter's stamina after they played a match.
 * Floored at 0.0.
 */
export function applyMatchCost(db, ownedFighterId) {
  const row = db
    .prepare('SELECT stamina FROM owned_fighter WHERE id = ?')
    .get(ownedFighterId);
  if (!row) return null;
  const next = Math.max(0, getEffectiveStamina(row) - MATCH_COST);
  db.prepare('UPDATE owned_fighter SET stamina = ? WHERE id = ?').run(next, ownedFighterId);
  return next;
}

/**
 * Award REST_RECOVERY to every non-retired fighter on `teamId` EXCEPT the
 * one who just played. Call in the same tx as applyMatchCost.
 * Returns the count of fighters bumped.
 */
export function applyTeamRest(db, teamId, exceptOwnedFighterId) {
  const r = db.prepare(`
    UPDATE owned_fighter
    SET stamina = MIN(1.0, stamina + ?)
    WHERE team_id = ? AND is_retired = 0 AND id != ?
  `).run(REST_RECOVERY, teamId, exceptOwnedFighterId);
  return r.changes;
}

/** Read stamina without mutating. */
export function readEffectiveStamina(db, ownedFighterId) {
  const row = db
    .prepare('SELECT stamina FROM owned_fighter WHERE id = ?')
    .get(ownedFighterId);
  if (!row) return null;
  return getEffectiveStamina(row);
}
