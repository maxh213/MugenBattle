/**
 * Bot transfer market simulation. Periodically each bot team scouts the
 * market: dumps its weakest fighter and shops for an upgrade if it can
 * afford one. Reuses the same market plumbing humans use (priceFor,
 * buyUnclaimedMaster, buyListedFighter) so a user buying a bot's listing or
 * outbidding a bot for an unclaimed fighter is just normal market activity.
 *
 * Decisions are made on a fitness score that weights both master-level
 * lifetime record and the team-specific owned record, plus a small bonus
 * for fighters that have actually been tested on the field.
 */

import { priceFor, buyUnclaimedMaster, buyListedFighter, releaseOwnedFighter, getKfmId } from './market.js';
import { topUpRoster } from './teams.js';

// ---------- Tunables ----------
const SELL_FITNESS_FLOOR = 0.30;       // dump if weakest fighter scores below this
const BUY_UPGRADE_DELTA = 0.10;        // candidate must be this much better
const BUDGET_RESERVE_FRACTION = 0.50;  // never spend more than 50% of cash
const LISTING_DISCOUNT = 0.90;         // bots list at 90% of priceFor()
const MIN_MATCHES_BEFORE_SELL = 5;     // don't dump untested fighters
const ACT_PROBABILITY = 0.15;          // ~15% of bots act per tick
const MAX_CANDIDATES_SCANNED = 200;    // cap shopping cost
const MIN_LISTING_PRICE_CENTS = 100;   // never list at $0 — looks weird

/**
 * Fitness score for a fighter, combining master-level + owned record. Range
 * roughly 0..1.5 (with the play-bonus adding above 1 for veteran fighters).
 *
 *   master_win_rate is the strongest signal — averages across all teams that
 *   ever fielded this character, smoothing local variance.
 *   owned_win_rate is a per-team record but small samples are noisy, so we
 *   weight it lower.
 *   play_bonus rewards fighters who've actually been used (a 100% win rate
 *   over 2 matches is worth less than 70% over 50).
 */
function fitnessOf({
  master_won = 0, master_lost = 0, master_drawn = 0,
  owned_won = 0, owned_lost = 0, owned_drawn = 0,
}) {
  const masterTotal = master_won + master_lost + master_drawn;
  const ownedTotal = owned_won + owned_lost + owned_drawn;
  const masterRate = masterTotal > 0 ? master_won / masterTotal : 0.5;
  const ownedRate = ownedTotal > 0 ? owned_won / ownedTotal : 0.5;
  const playBonus = Math.log10(1 + masterTotal + ownedTotal) * 0.10;
  return 0.6 * masterRate + 0.4 * ownedRate + playBonus;
}

/**
 * Fitness score for a master that has no owned record yet (market candidate).
 * Adds a novelty bonus for low-match-count masters so untested fighters
 * (0-0-0) are attractive enough for bots to speculate on. Without this,
 * the buy threshold of `weakest_active + 0.10` is never cleared by an
 * untested 0.5-fitness master, and unproven characters never get screen
 * time to build their record. Matches the bonus rebalanceLineup uses on
 * owned-fighter side so a fresh signing immediately enters the rotation.
 */
function fitnessOfMaster(f) {
  const total = (f.matches_won || 0) + (f.matches_lost || 0) + (f.matches_drawn || 0);
  const novelty = total === 0 ? 0.20 : (total < 5 ? 0.10 : 0);
  return fitnessOf({
    master_won: f.matches_won, master_lost: f.matches_lost, master_drawn: f.matches_drawn,
  }) + novelty;
}

/**
 * Active non-KFM fighters on the team, with all the columns we need for
 * fitness scoring + the master file_name (so the log line is readable).
 */
function activeRoster(db, teamId, kfmId) {
  return db.prepare(`
    SELECT of.id, of.master_fighter_id, of.priority, of.display_name,
      of.matches_won AS owned_won, of.matches_lost AS owned_lost, of.matches_drawn AS owned_drawn,
      f.file_name, f.display_name AS master_display_name,
      f.matches_won AS master_won, f.matches_lost AS master_lost, f.matches_drawn AS master_drawn
    FROM owned_fighter of
    JOIN fighter f ON f.id = of.master_fighter_id
    WHERE of.team_id = ? AND of.is_retired = 0 AND of.slot = 'active' AND of.master_fighter_id != ?
    ORDER BY of.priority, of.id
  `).all(teamId, kfmId);
}

/**
 * Mark an owned fighter as for_sale at `priceCents`. Bypasses the bench-only
 * gate that listForSale enforces for users — bots take active → for_sale
 * directly and rely on topUpRoster to refill the active slot.
 */
function botList(db, ownedFighterId, priceCents) {
  db.prepare(
    "UPDATE owned_fighter SET slot = 'for_sale', listing_price_cents = ? WHERE id = ?"
  ).run(priceCents, ownedFighterId);
}

/**
 * Decide whether and what to sell. Returns the listing record, or null.
 * Sells the single weakest active non-KFM fighter if it scores below the
 * floor and has at least MIN_MATCHES_BEFORE_SELL matches under its belt.
 */
function chooseSell(db, teamId, kfmId) {
  const actives = activeRoster(db, teamId, kfmId);
  if (actives.length === 0) return null;
  let worst = null;
  let worstScore = Infinity;
  for (const f of actives) {
    const total = (f.master_won + f.master_lost + f.master_drawn)
                + (f.owned_won + f.owned_lost + f.owned_drawn);
    if (total < MIN_MATCHES_BEFORE_SELL) continue;
    const s = fitnessOf(f);
    if (s < worstScore) { worstScore = s; worst = f; }
  }
  if (!worst || worstScore >= SELL_FITNESS_FLOOR) return null;
  const askingPrice = Math.max(
    MIN_LISTING_PRICE_CENTS,
    Math.round(priceFor({ matches_won: worst.master_won }) * LISTING_DISCOUNT),
  );
  return { fighter: worst, price: askingPrice, fitness: worstScore };
}

/**
 * Decide whether and what to buy. Returns one of:
 *   { kind: 'unclaimed', master, price, fitness }
 *   { kind: 'listing',   ownedFighterId, master, price, fitness }
 *   null
 *
 * Compares the best market candidate to the team's current weakest active
 * fighter. Only buys if the upgrade beats `BUY_UPGRADE_DELTA` AND we can
 * afford it within the budget reserve.
 */
function chooseBuy(db, teamId, balanceCents, kfmId) {
  // What's the bar to clear? The weakest active, ignoring training dummies.
  const actives = activeRoster(db, teamId, kfmId);
  const weakestFitness = actives.length
    ? Math.min(...actives.map(fitnessOf))
    : 0;

  const maxSpend = Math.floor(balanceCents * BUDGET_RESERVE_FRACTION);
  // Bench-room check moved to caller (`tickBotMarket`) so it can release a
  // bench fighter to make space when the team really wants an upgrade. We
  // still return null here if there's no candidate worth pursuing, to avoid
  // wasted releases.

  // Unclaimed pool — affordable, fittest first.
  const unclaimed = db.prepare(`
    SELECT f.id, f.file_name, f.display_name,
      f.matches_won, f.matches_lost, f.matches_drawn
    FROM fighter f
    WHERE f.is_master = 1 AND f.active = 1 AND f.is_unique = 1
      AND NOT EXISTS (SELECT 1 FROM owned_fighter o
                      WHERE o.master_fighter_id = f.id AND o.is_retired = 0)
    ORDER BY f.matches_won DESC
    LIMIT ?
  `).all(MAX_CANDIDATES_SCANNED);

  // Bot/user listings — affordable, fittest first.
  const listings = db.prepare(`
    SELECT of.id AS owned_fighter_id, of.listing_price_cents,
      f.id AS master_id, f.file_name, f.display_name,
      f.matches_won, f.matches_lost, f.matches_drawn,
      t.user_id AS seller_user_id
    FROM owned_fighter of
    JOIN fighter f ON f.id = of.master_fighter_id
    JOIN team t ON t.id = of.team_id
    WHERE of.slot = 'for_sale' AND of.is_retired = 0
    ORDER BY f.matches_won DESC
    LIMIT ?
  `).all(MAX_CANDIDATES_SCANNED);

  let best = null;

  for (const m of unclaimed) {
    const price = priceFor(m);
    if (price > maxSpend) continue;
    const fit = fitnessOfMaster(m);
    if (fit < weakestFitness + BUY_UPGRADE_DELTA) continue;
    if (!best || fit > best.fitness) {
      best = { kind: 'unclaimed', master: m, price, fitness: fit };
    }
  }
  for (const l of listings) {
    const price = l.listing_price_cents;
    if (price > maxSpend) continue;
    if (l.seller_user_id == null) continue; // shouldn't happen
    const fit = fitnessOfMaster(l);
    if (fit < weakestFitness + BUY_UPGRADE_DELTA) continue;
    if (!best || fit > best.fitness) {
      best = {
        kind: 'listing',
        ownedFighterId: l.owned_fighter_id,
        master: l,
        price,
        fitness: fit,
      };
    }
  }
  return best;
}

/**
 * Combined-roster fitness for every non-KFM, non-retired, non-listed fighter
 * on the team — used to decide who's active and who's on the bench. Adds a
 * "novelty bonus" so newly-acquired fighters get a chance to play before
 * being judged on their record alone.
 */
function rosterWithFitness(db, teamId, kfmId) {
  const rows = db.prepare(`
    SELECT of.id, of.slot, of.priority, of.master_fighter_id, of.display_name,
      of.matches_won AS owned_won, of.matches_lost AS owned_lost, of.matches_drawn AS owned_drawn,
      f.file_name, f.display_name AS master_display_name,
      f.matches_won AS master_won, f.matches_lost AS master_lost, f.matches_drawn AS master_drawn
    FROM owned_fighter of
    JOIN fighter f ON f.id = of.master_fighter_id
    WHERE of.team_id = ? AND of.is_retired = 0 AND of.slot != 'for_sale'
      AND of.master_fighter_id != ?
  `).all(teamId, kfmId);
  return rows.map((r) => {
    const totalOwned = r.owned_won + r.owned_lost + r.owned_drawn;
    const novelty = totalOwned < 2 ? 0.20 : (totalOwned < 5 ? 0.10 : 0);
    return { ...r, fitness: fitnessOf(r) + novelty };
  });
}

/**
 * Rebuild the team's lineup so the top-fitness fighters are 'active' and the
 * rest are 'bench'. Bots keep their best-performing 5 in the field but the
 * novelty bonus inside rosterWithFitness pulls fresh acquisitions up so
 * they get tested before being relegated. KFM training-dummy slots stay
 * exactly where they are.
 */
function rebalanceLineup(db, teamId, kfmId) {
  const all = rosterWithFitness(db, teamId, kfmId);
  if (all.length === 0) return { promoted: [], demoted: [] };
  all.sort((a, b) => b.fitness - a.fitness);

  // Count how many KFM "training dummy" slots are already in the active
  // roster so we don't accidentally bump them out — they're untouchable.
  const kfmActive = db.prepare(
    "SELECT COUNT(*) AS n FROM owned_fighter WHERE team_id = ? AND is_retired = 0 AND slot = 'active' AND master_fighter_id = ?"
  ).get(teamId, kfmId).n;
  const targetActive = Math.max(0, 5 - kfmActive);

  const setActive = db.prepare("UPDATE owned_fighter SET slot = 'active', priority = ? WHERE id = ?");
  const setBench  = db.prepare("UPDATE owned_fighter SET slot = 'bench',  priority = ? WHERE id = ?");
  const promoted = [];
  const demoted = [];
  all.forEach((f, idx) => {
    if (idx < targetActive) {
      if (f.slot !== 'active') promoted.push(f);
      setActive.run(idx, f.id);
    } else {
      if (f.slot === 'active') demoted.push(f);
      setBench.run(idx - targetActive, f.id);
    }
  });
  return { promoted, demoted };
}

/**
 * Pick the worst bench fighter (by fitness) for release. Used to free a
 * bench slot when the bot has identified an upgrade in the market but has
 * no room. Excludes KFM dummies and fighters that have never been tested
 * (release a low-confidence guess over a weak veteran feels wrong).
 */
function chooseReleaseFromBench(db, teamId, kfmId) {
  const benchers = db.prepare(`
    SELECT of.id, of.master_fighter_id, of.display_name,
      of.matches_won AS owned_won, of.matches_lost AS owned_lost, of.matches_drawn AS owned_drawn,
      f.file_name, f.display_name AS master_display_name, f.author AS master_author,
      f.matches_won AS master_won, f.matches_lost AS master_lost, f.matches_drawn AS master_drawn
    FROM owned_fighter of
    JOIN fighter f ON f.id = of.master_fighter_id
    WHERE of.team_id = ? AND of.is_retired = 0 AND of.slot = 'bench' AND of.master_fighter_id != ?
  `).all(teamId, kfmId);
  if (benchers.length === 0) return null;
  let worst = null;
  let worstScore = Infinity;
  for (const f of benchers) {
    const s = fitnessOf(f);
    if (s < worstScore) { worstScore = s; worst = f; }
  }
  return worst ? { fighter: worst, fitness: worstScore } : null;
}

/**
 * Run one full transfer-market tick. Iterates bot teams in a deterministic
 * order and lets a random subset try one sell + one buy. Returns a small
 * stats blob the caller can log.
 */
export function tickBotMarket(db, { actProbability = ACT_PROBABILITY } = {}) {
  const kfmId = getKfmId(db);

  const bots = db.prepare(`
    SELECT u.id AS user_id, u.username, u.balance_cents,
      t.id AS team_id, t.name AS team_name
    FROM user_account u
    JOIN team t ON t.user_id = u.id
    WHERE u.is_bot = 1 AND u.is_banned = 0
  `).all();

  const stats = { bots: bots.length, considered: 0, sold: 0, bought: 0, log: [] };

  for (const bot of bots) {
    if (Math.random() >= actProbability) continue;
    stats.considered++;

    // ----- SELL phase -----
    const sell = chooseSell(db, bot.team_id, kfmId);
    if (sell) {
      try {
        const txSell = db.transaction(() => {
          botList(db, sell.fighter.id, sell.price);
          // Refill the active slot we just emptied so the team is ready for
          // its next fixture. topUpRoster pulls oldest unclaimed → still
          // varied across teams, doesn't fight the buy logic that prefers
          // best-fitness.
          topUpRoster(db, bot.team_id);
        });
        txSell();
        stats.sold++;
        stats.log.push(
          `${bot.username} listed ${sell.fighter.master_display_name || sell.fighter.file_name}`
          + ` for $${(sell.price / 100).toFixed(2)} (fitness ${sell.fitness.toFixed(2)})`
        );
      } catch (err) {
        stats.log.push(`${bot.username} sell failed: ${err.message}`);
      }
    }

    // ----- BUY phase -----
    // Re-read balance: the sell didn't credit anyone yet (proceeds arrive on
    // purchase), but topUpRoster never spends, so balance is unchanged.
    const balance = db.prepare('SELECT balance_cents FROM user_account WHERE id = ?')
      .get(bot.user_id).balance_cents;
    const buy = chooseBuy(db, bot.team_id, balance, kfmId);
    if (buy) {
      // Make room on the bench if needed by releasing the weakest bencher.
      // Only do this when we've actually identified a worthwhile upgrade;
      // chucking out a fighter with nothing on offer is just churn.
      const benchCount = db.prepare(
        "SELECT COUNT(*) AS n FROM owned_fighter WHERE team_id = ? AND is_retired = 0 AND slot = 'bench'"
      ).get(bot.team_id).n;
      if (benchCount >= 5) {
        const release = chooseReleaseFromBench(db, bot.team_id, kfmId);
        if (release) {
          const r = releaseOwnedFighter(db, bot.user_id, release.fighter.id);
          if (r.ok) {
            stats.released = (stats.released || 0) + 1;
            stats.log.push(
              `${bot.username} released ${release.fighter.master_display_name || release.fighter.file_name}`
              + ` (fitness ${release.fitness.toFixed(2)}) to free a bench slot`
            );
          }
        }
      }
      const r = buy.kind === 'unclaimed'
        ? buyUnclaimedMaster(db, bot.user_id, buy.master.id)
        : buyListedFighter(db, bot.user_id, buy.ownedFighterId);
      if (r.ok) {
        stats.bought++;
        const tag = buy.kind === 'unclaimed' ? 'unclaimed' : 'listing';
        stats.log.push(
          `${bot.username} bought ${buy.master.display_name || buy.master.file_name}`
          + ` (${tag}) for $${(buy.price / 100).toFixed(2)} (fitness ${buy.fitness.toFixed(2)})`
        );
      }
    }

    // ----- REBALANCE phase -----
    // Sort active+bench by fitness so this bot fields its strongest 5 next
    // fixture. Novelty-bonus inside rosterWithFitness pulls untested fighters
    // (just bought, just topped-up) into the active rotation for a few
    // matches before being judged on their record.
    try {
      const r = rebalanceLineup(db, bot.team_id, kfmId);
      if (r.promoted.length > 0 || r.demoted.length > 0) {
        stats.rebalanced = (stats.rebalanced || 0) + 1;
        for (const p of r.promoted) {
          stats.log.push(
            `${bot.username} promoted ${p.master_display_name || p.file_name} to active (fitness ${p.fitness.toFixed(2)})`
          );
        }
      }
    } catch (err) {
      stats.log.push(`${bot.username} rebalance failed: ${err.message}`);
    }
  }

  return stats;
}
