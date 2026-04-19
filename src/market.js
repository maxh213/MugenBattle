/**
 * Master-roster market. Every unique master is in exactly one of two states:
 *   - owned: there exists a non-retired owned_fighter referencing it
 *   - unclaimed: nothing owns it → it's listed in the market
 *
 * Pricing: price_cents = max(0, fighter.matches_won - 2) * 100.
 *   First 2 wins are free — lets new signups grab reasonable chars even after
 *   a master has played a season or two. Winners scale up linearly.
 *
 * KFM (is_unique = 0) is the training dummy: unlimited copies allowed, never
 * shows up in the market, always available as a fallback.
 */

const KFM_FILE_NAME = 'kfm';
const PRICE_FREE_THRESHOLD = 2;
const PRICE_PER_WIN_CENTS = 100;

export function priceFor(fighter) {
  const wins = Math.max(0, Number(fighter.matches_won) || 0);
  const chargeable = Math.max(0, wins - PRICE_FREE_THRESHOLD);
  return chargeable * PRICE_PER_WIN_CENTS;
}

export function getKfmId(db) {
  const row = db.prepare('SELECT id FROM fighter WHERE file_name = ? AND is_master = 1').get(KFM_FILE_NAME);
  if (!row) throw new Error('KFM master not found — required as training dummy');
  return row.id;
}

/**
 * Returns masters currently unclaimed (no non-retired owned_fighter references
 * them), optionally filtered to 0-win fresh masters. Active + master + unique
 * only. Ordered randomly for draw purposes.
 */
export function listUnclaimed(db, { winsMax = null, limit = null } = {}) {
  const clauses = [
    'f.is_master = 1',
    'f.active = 1',
    'f.is_unique = 1',
    `NOT EXISTS (
      SELECT 1 FROM owned_fighter of
      WHERE of.master_fighter_id = f.id AND of.is_retired = 0
    )`,
  ];
  if (winsMax != null) clauses.push(`f.matches_won <= ${Number(winsMax)}`);
  let sql = `SELECT f.* FROM fighter f WHERE ${clauses.join(' AND ')} ORDER BY RANDOM()`;
  if (limit != null) sql += ` LIMIT ${Number(limit)}`;
  return db.prepare(sql).all();
}

/**
 * Pick `count` masters for a starter team. Tries 0-win unclaimed first; if
 * fewer than `count` exist, pads the remainder with KFM (which is always
 * returned as the plain master row — caller decides how to duplicate it).
 */
export function drawStarterMasters(db, count) {
  const picks = listUnclaimed(db, { winsMax: 0, limit: count });
  const kfmId = getKfmId(db);
  const kfmRow = db.prepare('SELECT * FROM fighter WHERE id = ?').get(kfmId);

  while (picks.length < count) {
    picks.push(kfmRow);
  }
  return picks;
}

/**
 * Market listing view: unclaimed unique masters with their current price.
 */
export function marketListings(db, { limit = 100 } = {}) {
  const rows = listUnclaimed(db);
  return rows.slice(0, limit).map((f) => ({
    id: f.id,
    file_name: f.file_name,
    display_name: f.display_name,
    author: f.author,
    matches_won: f.matches_won,
    price_cents: priceFor(f),
  }));
}
