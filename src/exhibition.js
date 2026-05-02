/**
 * Exhibition matches: ad-hoc one-off matches between two owned_fighters
 * requested by a user. Run on dedicated exhibition workers, completely
 * separate from league fixture workers. Stat updates apply to both fighters
 * (W/L/D, stamina, master record via runOwnedFighterMatch → applyMatchOutcome)
 * but no league standings, fixtures, or division_team rows are touched.
 */

import { runOwnedFighterMatch } from './match.js';

/**
 * Owned-fighter pickers for the exhibition page. Returns three buckets:
 *   - mine: the requester's own roster (active + bench, retired excluded)
 *   - others: every other team's active roster
 *   - market: for_sale listings
 *
 * Retired clones are skipped: their master is back in the unclaimed pool, so
 * the user should buy from the market to spar with that master again.
 */
export function listExhibitionFighters(db, userId) {
  const myTeam = userId
    ? db.prepare('SELECT id FROM team WHERE user_id = ?').get(userId)
    : null;
  const myTeamId = myTeam ? myTeam.id : 0;

  const rows = db.prepare(`
    SELECT of.id AS owned_fighter_id,
           of.display_name,
           of.matches_won, of.matches_lost, of.matches_drawn,
           of.stamina, of.stamina_updated_at, of.slot,
           f.id AS master_id,
           f.file_name AS master_file_name,
           f.display_name AS master_display_name,
           f.author AS master_author,
           f.active AS master_active,
           t.id AS team_id, t.name AS team_name,
           u.id AS user_id, u.username, u.is_bot
    FROM owned_fighter of
    JOIN fighter f ON f.id = of.master_fighter_id
    JOIN team t ON t.id = of.team_id
    JOIN user_account u ON u.id = t.user_id
    WHERE of.is_retired = 0
      AND f.active = 1
    ORDER BY t.id, of.priority, of.id
  `).all();

  const mine = [];
  const others = [];
  const market = [];
  for (const r of rows) {
    if (r.slot === 'for_sale') market.push(r);
    else if (r.team_id === myTeamId) mine.push(r);
    else others.push(r);
  }
  return { mine, others, market };
}

export function enqueueExhibition(db, { requesterId, homeId, awayId, stageId }) {
  const home = db.prepare('SELECT id, is_retired FROM owned_fighter WHERE id = ?').get(homeId);
  const away = db.prepare('SELECT id, is_retired FROM owned_fighter WHERE id = ?').get(awayId);
  if (!home) return { error: 'home_not_found' };
  if (!away) return { error: 'away_not_found' };
  if (home.is_retired || away.is_retired) return { error: 'retired_fighter' };
  if (home.id === away.id) return { error: 'same_fighter' };

  if (stageId != null) {
    const stage = db.prepare('SELECT id FROM stage WHERE id = ? AND active = 1').get(stageId);
    if (!stage) return { error: 'stage_not_found' };
  }
  const id = db.prepare(
    `INSERT INTO exhibition_match (requester_user_id, home_owned_fighter_id, away_owned_fighter_id, stage_id)
     VALUES (?, ?, ?, ?)`
  ).run(requesterId, homeId, awayId, stageId || null).lastInsertRowid;
  return { id };
}

export function getExhibition(db, id) {
  const row = db.prepare(`
    SELECT em.*,
      hof.display_name AS home_name, hof.team_id AS home_team_id,
      ht.name AS home_team_name, hu.username AS home_username,
      hf.display_name AS home_master_name, hf.author AS home_author, hf.file_name AS home_file_name,
      aof.display_name AS away_name, aof.team_id AS away_team_id,
      at.name AS away_team_name, au.username AS away_username,
      af.display_name AS away_master_name, af.author AS away_author, af.file_name AS away_file_name,
      s.display_name AS stage_display, s.file_name AS stage_file, s.author AS stage_author
    FROM exhibition_match em
    JOIN owned_fighter hof ON hof.id = em.home_owned_fighter_id
    JOIN fighter hf ON hf.id = hof.master_fighter_id
    JOIN team ht ON ht.id = hof.team_id
    JOIN user_account hu ON hu.id = ht.user_id
    JOIN owned_fighter aof ON aof.id = em.away_owned_fighter_id
    JOIN fighter af ON af.id = aof.master_fighter_id
    JOIN team at ON at.id = aof.team_id
    JOIN user_account au ON au.id = at.user_id
    LEFT JOIN stage s ON s.id = em.stage_id
    WHERE em.id = ?
  `).get(id);
  return row || null;
}

/**
 * Atomically claim the next pending exhibition for a worker. Returns the row
 * (now status='running') or null. Avoids race when multiple exhibition workers
 * poll concurrently.
 */
export function claimNextPendingExhibition(db, workerId) {
  const tx = db.transaction(() => {
    const row = db.prepare(
      `SELECT id FROM exhibition_match WHERE status = 'pending' ORDER BY id LIMIT 1`
    ).get();
    if (!row) return null;
    const result = db.prepare(
      `UPDATE exhibition_match SET status = 'running', worker_id = ?, started_at = datetime('now')
       WHERE id = ? AND status = 'pending'`
    ).run(workerId, row.id);
    if (result.changes !== 1) return null;
    return getExhibition(db, row.id);
  });
  return tx();
}

/**
 * Run a previously-claimed exhibition match end-to-end. Picks a random active
 * stage if none was set. Updates owned + master fighter stats and marks the
 * exhibition row complete. Throws on irrecoverable error after marking
 * 'failed' in the DB so the worker can move on.
 */
export async function runExhibition(db, exhibitionId, ctx) {
  const ex = getExhibition(db, exhibitionId);
  if (!ex) throw new Error(`exhibition ${exhibitionId} not found`);

  let stageFile = ex.stage_file;
  if (!stageFile) {
    const random = db.prepare(
      `SELECT file_name FROM stage WHERE active = 1 ORDER BY RANDOM() LIMIT 1`
    ).get();
    stageFile = random ? random.file_name : null;
  }
  if (!stageFile) {
    db.prepare(
      `UPDATE exhibition_match SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`
    ).run('no active stage available', exhibitionId);
    throw new Error('no active stage available');
  }

  try {
    const r = await runOwnedFighterMatch({
      db,
      homeOwnedFighterId: ex.home_owned_fighter_id,
      awayOwnedFighterId: ex.away_owned_fighter_id,
      stageFileName: stageFile,
      ctx,
      // Exhibitions are sparring sessions: real W/L/D, full life on both
      // sides, no stamina drain or teammate rest.
      affectStamina: false,
    });
    let winnerOwnedFighterId = null;
    if (r.winner === 'fighter1') winnerOwnedFighterId = ex.home_owned_fighter_id;
    else if (r.winner === 'fighter2') winnerOwnedFighterId = ex.away_owned_fighter_id;
    db.prepare(
      `UPDATE exhibition_match
         SET status = 'complete', winner_owned_fighter_id = ?, result = ?, finished_at = datetime('now')
       WHERE id = ?`
    ).run(winnerOwnedFighterId, r.winner, exhibitionId);
    return { ok: true, result: r };
  } catch (err) {
    db.prepare(
      `UPDATE exhibition_match SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(err.message?.slice(0, 500) || 'unknown', exhibitionId);
    throw err;
  }
}

/**
 * Recent exhibitions for a user — just enough fields for the page to show
 * "your last 10 sparring sessions".
 */
export function listExhibitionsForUser(db, userId, limit = 10) {
  return db.prepare(`
    SELECT em.id, em.status, em.result, em.created_at, em.started_at, em.finished_at,
      em.home_owned_fighter_id, em.away_owned_fighter_id, em.winner_owned_fighter_id,
      hof.display_name AS home_name, aof.display_name AS away_name,
      ht.name AS home_team_name, at.name AS away_team_name
    FROM exhibition_match em
    JOIN owned_fighter hof ON hof.id = em.home_owned_fighter_id
    JOIN owned_fighter aof ON aof.id = em.away_owned_fighter_id
    JOIN team ht ON ht.id = hof.team_id
    JOIN team at ON at.id = aof.team_id
    WHERE em.requester_user_id = ?
    ORDER BY em.id DESC
    LIMIT ?
  `).all(userId, limit);
}

/**
 * Crash recovery: any exhibition left 'running' from a previous boot is reset
 * to 'failed'. We don't auto-reschedule because the user may have left the
 * page; they can simply click again.
 */
export function resetStuckExhibitions(db) {
  const r = db.prepare(
    `UPDATE exhibition_match SET status = 'failed', error = 'server restarted before match completed', finished_at = datetime('now') WHERE status = 'running'`
  ).run();
  return r.changes;
}
