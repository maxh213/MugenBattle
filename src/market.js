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

import { credit } from './wallet.js';

const KFM_FILE_NAME = 'kfm';
const PRICE_FREE_THRESHOLD = 2;
const PRICE_PER_WIN_CENTS = 100;
const MAX_BENCH_SIZE = 5;
const MIN_LIST_PRICE_CENTS = 0;
const MAX_LIST_PRICE_CENTS = 1_000_000; // $10k sanity cap

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
    matches_lost: f.matches_lost,
    matches_drawn: f.matches_drawn,
    price_cents: priceFor(f),
  }));
}

/**
 * Buy an unclaimed unique master and add it to the user's bench.
 * Atomic: ownership check + balance debit + owned_fighter insert in one tx.
 * Returns { ok, owned_fighter_id, price_cents } or { error, detail }.
 *
 * Errors:
 *   not_signed_in        — no user id (caller should 401)
 *   no_team              — user hasn't completed signup
 *   master_not_available — master inactive, not unique, or not found
 *   master_already_owned — someone else owns an active clone
 *   bench_full           — team already has MAX_BENCH_SIZE bench fighters
 *   insufficient_balance — user can't cover the price
 */
export function buyUnclaimedMaster(db, userId, masterId) {
  if (!userId) return { error: 'not_signed_in' };
  const tx = db.transaction(() => {
    const team = db.prepare('SELECT id FROM team WHERE user_id = ?').get(userId);
    if (!team) return { error: 'no_team' };

    const master = db.prepare(
      'SELECT id, file_name, display_name, matches_won FROM fighter WHERE id = ? AND is_master = 1 AND is_unique = 1 AND active = 1'
    ).get(masterId);
    if (!master) return { error: 'master_not_available' };

    const existing = db.prepare(
      'SELECT id FROM owned_fighter WHERE master_fighter_id = ? AND is_retired = 0'
    ).get(masterId);
    if (existing) return { error: 'master_already_owned' };

    const { n: benchCount } = db.prepare(
      "SELECT COUNT(*) AS n FROM owned_fighter WHERE team_id = ? AND is_retired = 0 AND slot = 'bench'"
    ).get(team.id);
    if (benchCount >= MAX_BENCH_SIZE) return { error: 'bench_full' };

    const price = priceFor(master);
    const { balance_cents } = db.prepare('SELECT balance_cents FROM user_account WHERE id = ?').get(userId);
    if (balance_cents < price) {
      return { error: 'insufficient_balance', need: price, have: balance_cents };
    }

    const ins = db.prepare(
      "INSERT INTO owned_fighter (team_id, master_fighter_id, display_name, slot, priority) VALUES (?, ?, ?, 'bench', ?)"
    ).run(team.id, master.id, master.display_name || master.file_name, benchCount);
    const ownedId = ins.lastInsertRowid;

    db.prepare(
      'INSERT INTO owned_fighter_team_history (owned_fighter_id, team_id, reason) VALUES (?, ?, ?)'
    ).run(ownedId, team.id, 'bought_from_market');

    if (price > 0) credit(db, userId, -price, `buy_master:${master.id}`, ownedId);

    return { ok: true, owned_fighter_id: ownedId, price_cents: price };
  });
  return tx();
}

/**
 * Suggested asking price for a user-listed fighter = the master's lifetime
 * price. Users can list above or below this — it's just a nudge.
 */
export function suggestedPriceForOwned(db, ownedFighterId) {
  const row = db.prepare(`
    SELECT f.matches_won
    FROM owned_fighter of JOIN fighter f ON of.master_fighter_id = f.id
    WHERE of.id = ?
  `).get(ownedFighterId);
  if (!row) return null;
  return priceFor(row);
}

/**
 * List a bench fighter for sale at `priceCents`. Flips slot → for_sale and
 * saves the price. Errors: not_your_fighter, not_on_bench, bad_price.
 */
export function listForSale(db, userId, ownedFighterId, priceCents) {
  const n = Number(priceCents);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_LIST_PRICE_CENTS || n > MAX_LIST_PRICE_CENTS) {
    return { error: 'bad_price', min: MIN_LIST_PRICE_CENTS, max: MAX_LIST_PRICE_CENTS };
  }
  const tx = db.transaction(() => {
    const row = db.prepare(`
      SELECT of.id, of.slot, of.is_retired, t.user_id
      FROM owned_fighter of JOIN team t ON of.team_id = t.id
      WHERE of.id = ?
    `).get(ownedFighterId);
    if (!row) return { error: 'not_found' };
    if (row.user_id !== userId) return { error: 'not_your_fighter' };
    if (row.is_retired) return { error: 'retired' };
    if (row.slot !== 'bench') return { error: 'not_on_bench', current_slot: row.slot };
    db.prepare(
      "UPDATE owned_fighter SET slot = 'for_sale', listing_price_cents = ? WHERE id = ?"
    ).run(n, ownedFighterId);
    return { ok: true, price_cents: n };
  });
  return tx();
}

/**
 * Un-list: flip slot back to bench, clear the price. Requires bench to have
 * room (owner must first reshuffle if bench is full).
 */
export function unlistFromSale(db, userId, ownedFighterId) {
  const tx = db.transaction(() => {
    const row = db.prepare(`
      SELECT of.id, of.slot, of.is_retired, of.team_id, t.user_id
      FROM owned_fighter of JOIN team t ON of.team_id = t.id
      WHERE of.id = ?
    `).get(ownedFighterId);
    if (!row) return { error: 'not_found' };
    if (row.user_id !== userId) return { error: 'not_your_fighter' };
    if (row.is_retired) return { error: 'retired' };
    if (row.slot !== 'for_sale') return { error: 'not_listed', current_slot: row.slot };
    const { n: benchCount } = db.prepare(
      "SELECT COUNT(*) AS n FROM owned_fighter WHERE team_id = ? AND is_retired = 0 AND slot = 'bench'"
    ).get(row.team_id);
    if (benchCount >= MAX_BENCH_SIZE) return { error: 'bench_full' };
    db.prepare(
      "UPDATE owned_fighter SET slot = 'bench', listing_price_cents = NULL WHERE id = ?"
    ).run(ownedFighterId);
    return { ok: true };
  });
  return tx();
}

/**
 * Buyer purchases a listed fighter from another user. Atomic transfer of
 * ownership + money. Lands on buyer's bench.
 *
 * Errors: not_signed_in, no_team, not_for_sale, own_listing, bench_full,
 * insufficient_balance.
 */
export function buyListedFighter(db, buyerUserId, ownedFighterId) {
  if (!buyerUserId) return { error: 'not_signed_in' };
  const tx = db.transaction(() => {
    const listing = db.prepare(`
      SELECT of.id, of.slot, of.is_retired, of.listing_price_cents,
        of.team_id AS seller_team_id, t.user_id AS seller_user_id,
        of.master_fighter_id
      FROM owned_fighter of JOIN team t ON of.team_id = t.id
      WHERE of.id = ?
    `).get(ownedFighterId);
    if (!listing || listing.is_retired) return { error: 'not_found' };
    if (listing.slot !== 'for_sale' || listing.listing_price_cents == null) {
      return { error: 'not_for_sale' };
    }
    if (listing.seller_user_id === buyerUserId) return { error: 'own_listing' };

    const buyerTeam = db.prepare('SELECT id FROM team WHERE user_id = ?').get(buyerUserId);
    if (!buyerTeam) return { error: 'no_team' };

    const { n: benchCount } = db.prepare(
      "SELECT COUNT(*) AS n FROM owned_fighter WHERE team_id = ? AND is_retired = 0 AND slot = 'bench'"
    ).get(buyerTeam.id);
    if (benchCount >= MAX_BENCH_SIZE) return { error: 'bench_full' };

    const price = listing.listing_price_cents;
    const { balance_cents } = db.prepare(
      'SELECT balance_cents FROM user_account WHERE id = ?'
    ).get(buyerUserId);
    if (balance_cents < price) {
      return { error: 'insufficient_balance', need: price, have: balance_cents };
    }

    // Transfer: slot → bench on buyer's team, clear listing price.
    db.prepare(`
      UPDATE owned_fighter
      SET team_id = ?, slot = 'bench', priority = ?, listing_price_cents = NULL
      WHERE id = ?
    `).run(buyerTeam.id, benchCount, ownedFighterId);

    // History row for the transfer.
    db.prepare(
      'INSERT INTO owned_fighter_team_history (owned_fighter_id, team_id, reason) VALUES (?, ?, ?)'
    ).run(ownedFighterId, buyerTeam.id, 'bought_from_user');

    // Money: buyer debited, seller credited.
    if (price > 0) {
      credit(db, buyerUserId, -price, 'buy_listing', ownedFighterId);
      credit(db, listing.seller_user_id, price, 'sell_listing', ownedFighterId);
    }

    return { ok: true, owned_fighter_id: ownedFighterId, price_cents: price };
  });
  return tx();
}

// ---------- Stages ----------

/**
 * Stage pricing uses times_used as the "matches played" analogue. First 2
 * plays free, then 100 cents per additional play.
 */
export function priceForStage(stage) {
  const used = Math.max(0, Number(stage.times_used) || 0);
  const chargeable = Math.max(0, used - PRICE_FREE_THRESHOLD);
  return chargeable * PRICE_PER_WIN_CENTS;
}

/** Unclaimed stages available for purchase. */
export function marketStageListings(db, { limit = 100 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM stage
    WHERE active = 1 AND is_unique = 1 AND owner_team_id IS NULL
    ORDER BY RANDOM() LIMIT ?
  `).all(limit);
  return rows.map((s) => ({
    id: s.id,
    file_name: s.file_name,
    display_name: s.display_name,
    author: s.author,
    times_used: s.times_used,
    price_cents: priceForStage(s),
  }));
}

/** User-listed stages currently for sale. */
export function userStageListings(db, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT s.id AS stage_id, s.file_name, s.display_name, s.author, s.times_used,
      s.listing_price_cents AS price_cents,
      t.id AS team_id, t.name AS team_name,
      u.id AS seller_user_id, u.username AS seller_username
    FROM stage s
    JOIN team t ON s.owner_team_id = t.id
    JOIN user_account u ON t.user_id = u.id
    WHERE s.active = 1 AND s.owner_team_id IS NOT NULL
      AND s.listing_price_cents IS NOT NULL
    ORDER BY s.listing_price_cents ASC LIMIT ?
  `).all(limit);
}

/** Snapshot of the team's home stage (or null). */
export function getHomeStage(db, teamId) {
  return db.prepare(`
    SELECT id, file_name, display_name, author, times_used, listing_price_cents
    FROM stage WHERE owner_team_id = ? AND active = 1 LIMIT 1
  `).get(teamId) || null;
}

/**
 * Buy an unclaimed stage. Each team may own at most one — reject if they
 * already have a home stage.
 */
export function buyUnclaimedStage(db, userId, stageId) {
  if (!userId) return { error: 'not_signed_in' };
  const tx = db.transaction(() => {
    const team = db.prepare('SELECT id FROM team WHERE user_id = ?').get(userId);
    if (!team) return { error: 'no_team' };
    const existing = getHomeStage(db, team.id);
    if (existing) return { error: 'already_own_stage', current: existing.file_name };
    const stage = db.prepare(
      'SELECT id, file_name, display_name, times_used, owner_team_id FROM stage WHERE id = ? AND active = 1 AND is_unique = 1'
    ).get(stageId);
    if (!stage) return { error: 'stage_not_available' };
    if (stage.owner_team_id != null) return { error: 'stage_already_owned' };
    const price = priceForStage(stage);
    const { balance_cents } = db.prepare('SELECT balance_cents FROM user_account WHERE id = ?').get(userId);
    if (balance_cents < price) return { error: 'insufficient_balance', need: price, have: balance_cents };
    db.prepare('UPDATE stage SET owner_team_id = ? WHERE id = ?').run(team.id, stageId);
    if (price > 0) credit(db, userId, -price, 'buy_stage', stageId);
    return { ok: true, stage_id: stageId, price_cents: price };
  });
  return tx();
}

/** Owner lists their stage at an asking price. Doesn't remove it from home. */
export function listStageForSale(db, userId, stageId, priceCents) {
  const n = Number(priceCents);
  if (!Number.isInteger(n) || n < MIN_LIST_PRICE_CENTS || n > MAX_LIST_PRICE_CENTS) {
    return { error: 'bad_price', min: MIN_LIST_PRICE_CENTS, max: MAX_LIST_PRICE_CENTS };
  }
  const tx = db.transaction(() => {
    const stage = db.prepare(`
      SELECT s.id, s.owner_team_id, t.user_id
      FROM stage s LEFT JOIN team t ON s.owner_team_id = t.id
      WHERE s.id = ?
    `).get(stageId);
    if (!stage) return { error: 'stage_not_found' };
    if (stage.user_id !== userId) return { error: 'not_your_stage' };
    db.prepare('UPDATE stage SET listing_price_cents = ? WHERE id = ?').run(n, stageId);
    return { ok: true, price_cents: n };
  });
  return tx();
}

/**
 * Give up a stage back to the pool — owner relinquishes, no money back.
 */
export function releaseStage(db, userId, stageId) {
  const tx = db.transaction(() => {
    const stage = db.prepare(`
      SELECT s.id, s.owner_team_id, t.user_id
      FROM stage s LEFT JOIN team t ON s.owner_team_id = t.id
      WHERE s.id = ?
    `).get(stageId);
    if (!stage) return { error: 'stage_not_found' };
    if (stage.user_id !== userId) return { error: 'not_your_stage' };
    db.prepare('UPDATE stage SET owner_team_id = NULL, listing_price_cents = NULL WHERE id = ?').run(stageId);
    return { ok: true };
  });
  return tx();
}

/** Remove the for-sale flag; stage stays owned by the same team. */
export function unlistStage(db, userId, stageId) {
  const tx = db.transaction(() => {
    const stage = db.prepare(`
      SELECT s.id, s.owner_team_id, t.user_id
      FROM stage s LEFT JOIN team t ON s.owner_team_id = t.id
      WHERE s.id = ?
    `).get(stageId);
    if (!stage) return { error: 'stage_not_found' };
    if (stage.user_id !== userId) return { error: 'not_your_stage' };
    db.prepare('UPDATE stage SET listing_price_cents = NULL WHERE id = ?').run(stageId);
    return { ok: true };
  });
  return tx();
}

/**
 * P2P: buyer takes a listed stage off the seller, pays, becomes new owner.
 * Buyer must not already own a stage. Listing price clears on sale.
 */
export function buyListedStage(db, buyerUserId, stageId) {
  if (!buyerUserId) return { error: 'not_signed_in' };
  const tx = db.transaction(() => {
    const listing = db.prepare(`
      SELECT s.id, s.owner_team_id, s.listing_price_cents, t.user_id AS seller_user_id
      FROM stage s LEFT JOIN team t ON s.owner_team_id = t.id
      WHERE s.id = ?
    `).get(stageId);
    if (!listing) return { error: 'not_found' };
    if (listing.owner_team_id == null || listing.listing_price_cents == null) {
      return { error: 'not_for_sale' };
    }
    if (listing.seller_user_id === buyerUserId) return { error: 'own_listing' };

    const buyerTeam = db.prepare('SELECT id FROM team WHERE user_id = ?').get(buyerUserId);
    if (!buyerTeam) return { error: 'no_team' };
    const existing = getHomeStage(db, buyerTeam.id);
    if (existing) return { error: 'already_own_stage', current: existing.file_name };

    const price = listing.listing_price_cents;
    const { balance_cents } = db.prepare('SELECT balance_cents FROM user_account WHERE id = ?').get(buyerUserId);
    if (balance_cents < price) return { error: 'insufficient_balance', need: price, have: balance_cents };

    db.prepare('UPDATE stage SET owner_team_id = ?, listing_price_cents = NULL WHERE id = ?')
      .run(buyerTeam.id, stageId);
    if (price > 0) {
      credit(db, buyerUserId, -price, 'buy_stage_listing', stageId);
      credit(db, listing.seller_user_id, price, 'sell_stage_listing', stageId);
    }
    return { ok: true, stage_id: stageId, price_cents: price };
  });
  return tx();
}

/**
 * Give up a fighter without selling — retire the owned clone, returning its
 * master to the unclaimed pool. Only bench or for_sale fighters; active
 * fighters must be benched first (else the 5-active invariant breaks).
 */
export function releaseOwnedFighter(db, userId, ownedFighterId) {
  const tx = db.transaction(() => {
    const row = db.prepare(`
      SELECT of.id, of.slot, of.is_retired, t.user_id
      FROM owned_fighter of JOIN team t ON of.team_id = t.id
      WHERE of.id = ?
    `).get(ownedFighterId);
    if (!row) return { error: 'not_found' };
    if (row.user_id !== userId) return { error: 'not_your_fighter' };
    if (row.is_retired) return { error: 'already_retired' };
    if (row.slot === 'active') return { error: 'active_slot' };
    db.prepare(
      'UPDATE owned_fighter SET is_retired = 1, slot = \'bench\', listing_price_cents = NULL WHERE id = ?'
    ).run(ownedFighterId);
    return { ok: true };
  });
  return tx();
}

/**
 * All user-listed fighters currently for sale. Joined with master + seller
 * info so the market UI can render without extra fetches.
 */
export function userListings(db, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT of.id AS owned_fighter_id,
      of.display_name,
      of.listing_price_cents AS price_cents,
      of.matches_won, of.matches_lost, of.matches_drawn,
      f.id AS master_id, f.file_name, f.display_name AS master_display_name, f.author,
      t.id AS team_id, t.name AS team_name,
      u.id AS seller_user_id, u.username AS seller_username
    FROM owned_fighter of
    JOIN fighter f ON of.master_fighter_id = f.id
    JOIN team t ON of.team_id = t.id
    JOIN user_account u ON t.user_id = u.id
    WHERE of.slot = 'for_sale' AND of.is_retired = 0
    ORDER BY of.listing_price_cents ASC, of.id DESC
    LIMIT ?
  `).all(limit);
}
