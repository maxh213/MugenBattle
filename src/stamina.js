/**
 * Stamina model for owned fighters.
 *
 * Stored: `owned_fighter.stamina` (0.0..1.0) + `owned_fighter.stamina_updated_at`.
 * Effective (read): stored + (time since update) * RECOVERY_PER_HOUR, capped at 1.0.
 * On match: subtract MATCH_COST (floored at 0.0), refresh timestamp.
 * Life mapping: 1.0 stamina → FULL_LIFE. 0.0 → MIN_LIFE. Linear between.
 *   Floor chosen deliberately — a 0-stamina fighter should be weak, not
 *   catastrophically broken, else whole cascade-walkover logic re-triggers.
 */

export const MATCH_COST = 0.20;
export const RECOVERY_PER_HOUR = 0.10;
export const FULL_LIFE = 1000;
export const MIN_LIFE = 400;
export const LOW_STAMINA_ROTATION_THRESHOLD = 0.3;

function parseTs(s) {
  if (!s) return Date.now();
  // SQLite default datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC; append 'Z'.
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').replace(/\..+$/, '');
}

/**
 * Compute effective stamina for a fighter *without* persisting the recovery.
 * Pass the raw row from owned_fighter (needs stamina + stamina_updated_at).
 */
export function getEffectiveStamina({ stamina, stamina_updated_at }) {
  const stored = Number(stamina);
  if (!Number.isFinite(stored)) return 1.0;
  const ts = parseTs(stamina_updated_at);
  const hours = Math.max(0, (Date.now() - ts) / 3_600_000);
  return Math.min(1.0, Math.max(0.0, stored + hours * RECOVERY_PER_HOUR));
}

/** Convert 0..1 stamina to an absolute starting life value for Ikemen. */
export function staminaToLife(effStamina) {
  const clamped = Math.min(1.0, Math.max(0.0, effStamina));
  return Math.round(MIN_LIFE + (FULL_LIFE - MIN_LIFE) * clamped);
}

/**
 * Persist the effective stamina minus match cost, refreshing the timestamp.
 * Call this AFTER the match completes (pass result as metadata to adjust cost
 * later if desired; for v1 every match costs MATCH_COST).
 */
export function applyMatchCost(db, ownedFighterId) {
  const row = db
    .prepare('SELECT stamina, stamina_updated_at FROM owned_fighter WHERE id = ?')
    .get(ownedFighterId);
  if (!row) return null;
  const eff = getEffectiveStamina(row);
  const next = Math.max(0, eff - MATCH_COST);
  db.prepare('UPDATE owned_fighter SET stamina = ?, stamina_updated_at = ? WHERE id = ?')
    .run(next, nowSql(), ownedFighterId);
  return next;
}

/**
 * Read effective stamina WITHOUT decrementing. Use when displaying or when
 * deciding to rotate a bench fighter in.
 */
export function readEffectiveStamina(db, ownedFighterId) {
  const row = db
    .prepare('SELECT stamina, stamina_updated_at FROM owned_fighter WHERE id = ?')
    .get(ownedFighterId);
  if (!row) return null;
  return getEffectiveStamina(row);
}
