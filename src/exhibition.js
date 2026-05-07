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
           f.matches_won AS master_won,
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

  // Followed master IDs for the requester so the UI can pin starred fighters
  // to the top of the Other-teams tab and the picker can flag them visually.
  const followedMasters = userId
    ? new Set(db.prepare(
        "SELECT target_id FROM user_follow WHERE user_id = ? AND target_kind = 'master'"
      ).all(userId).map((r) => r.target_id))
    : new Set();

  const mine = [];
  const others = [];
  const market = [];
  for (const r of rows) {
    r.followed = followedMasters.has(r.master_id);
    if (r.slot === 'for_sale') market.push(r);
    else if (r.team_id === myTeamId) mine.push(r);
    else others.push(r);
  }
  // Other-teams pile: followed first, then by master win count descending,
  // then owned wins. Tie-break alphabetically on display_name so it's stable.
  others.sort((a, b) => {
    if (a.followed !== b.followed) return a.followed ? -1 : 1;
    const dm = (b.master_won || 0) - (a.master_won || 0);
    if (dm) return dm;
    const dw = (b.matches_won || 0) - (a.matches_won || 0);
    if (dw) return dw;
    return (a.display_name || '').localeCompare(b.display_name || '');
  });
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

/**
 * Create an exhibition tournament. `slotIds` is an array of owned_fighter
 * IDs in seed order (slot 0 plays slot 1 in round-1 match 0, etc.). All
 * round rows are pre-created — round 0 gets the seeded pairings, later
 * rounds start with null home/away and get filled as predecessors finish.
 *
 * Validates: size matches slotIds.length, no duplicates, no retired fighters.
 */
export function createExhibitionTournament(db, { requesterId, size, roundsPerFight, slotIds, stageId }) {
  if (![4, 8, 16, 32, 64].includes(size)) return { error: 'invalid_size' };
  if (![1, 3, 5].includes(roundsPerFight)) return { error: 'invalid_rounds_per_fight' };
  if (!Array.isArray(slotIds) || slotIds.length !== size) return { error: 'slot_count_mismatch' };
  const unique = new Set(slotIds);
  if (unique.size !== size) return { error: 'duplicate_fighter' };
  if (stageId != null) {
    const s = db.prepare('SELECT id FROM stage WHERE id = ? AND active = 1').get(stageId);
    if (!s) return { error: 'stage_not_found' };
  }
  // One active tournament per user. Prevents accidental double-queue and keeps
  // worker scheduling fair when many users queue at once.
  const existing = db.prepare(
    `SELECT id FROM exhibition_tournament WHERE requester_user_id = ? AND status IN ('pending', 'running') LIMIT 1`
  ).get(requesterId);
  if (existing) return { error: 'tournament_in_progress', existing_id: existing.id };
  const fighters = db.prepare(
    `SELECT id, is_retired FROM owned_fighter WHERE id IN (${slotIds.map(() => '?').join(',')})`
  ).all(...slotIds);
  if (fighters.length !== size) return { error: 'fighter_not_found' };
  if (fighters.some((f) => f.is_retired)) return { error: 'retired_fighter' };

  const tx = db.transaction(() => {
    const tournId = db.prepare(
      `INSERT INTO exhibition_tournament (requester_user_id, size, rounds_per_fight, stage_id)
       VALUES (?, ?, ?, ?)`
    ).run(requesterId, size, roundsPerFight, stageId || null).lastInsertRowid;
    const insertMatch = db.prepare(
      `INSERT INTO exhibition_tournament_match
         (tournament_id, round, match_index, home_owned_fighter_id, away_owned_fighter_id)
       VALUES (?, ?, ?, ?, ?)`
    );
    const totalRounds = Math.log2(size);
    for (let r = 0; r < totalRounds; r++) {
      const matchCount = size / Math.pow(2, r + 1);
      for (let m = 0; m < matchCount; m++) {
        const home = r === 0 ? slotIds[m * 2] : null;
        const away = r === 0 ? slotIds[m * 2 + 1] : null;
        insertMatch.run(tournId, r, m, home, away);
      }
    }
    return tournId;
  });
  return { id: tx() };
}

/**
 * List every running + pending tournament for the public /tournaments page.
 * Each item carries a fully-hydrated bracket so callers can render mini-
 * brackets without N+1 queries. Recently-finished tournaments aren't
 * included — they live on the leaderboard / individual profiles instead.
 */
export function listLiveTournaments(db) {
  const rows = db.prepare(`
    SELECT t.*, u.username AS requester_username, u.is_bot AS requester_is_bot
    FROM exhibition_tournament t
    JOIN user_account u ON u.id = t.requester_user_id
    WHERE t.status IN ('pending', 'running')
    ORDER BY
      CASE t.status WHEN 'running' THEN 0 ELSE 1 END,
      t.id ASC
  `).all();
  return rows.map((r) => {
    const t = getExhibitionTournament(db, r.id);
    return t && { ...t, requester_username: r.requester_username, requester_is_bot: !!r.requester_is_bot };
  }).filter(Boolean);
}

/**
 * The user's currently-active tournament (pending or running), or null.
 * Used by the page to hydrate state on reload so users can't queue a
 * second one while the first is still alive.
 */
export function getActiveTournamentForUser(db, userId) {
  const row = db.prepare(
    `SELECT id FROM exhibition_tournament
     WHERE requester_user_id = ? AND status IN ('pending', 'running')
     ORDER BY id DESC LIMIT 1`
  ).get(userId);
  if (!row) return null;
  return getExhibitionTournament(db, row.id);
}

/**
 * Cancel a pending tournament. Only the owner can cancel, and only while
 * still pending — once the runner has started matches, cancelling would
 * leave half-played stats so we refuse.
 */
export function cancelExhibitionTournament(db, { id, userId }) {
  const t = db.prepare('SELECT * FROM exhibition_tournament WHERE id = ?').get(id);
  if (!t) return { error: 'not_found' };
  if (t.requester_user_id !== userId) return { error: 'not_owner' };
  if (t.status !== 'pending') return { error: 'not_cancellable', status: t.status };
  db.prepare(
    `UPDATE exhibition_tournament SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?`
  ).run(id);
  return { ok: true };
}

/**
 * Atomically claim the oldest pending tournament match where both fighters
 * are set (otherwise the runner can't fight it yet) and the parent
 * tournament hasn't been cancelled. Marks the match running + bumps the
 * tournament from pending→running if it isn't already.
 */
export function claimNextPendingTournamentMatch(db, workerId, maxConcurrent = Infinity) {
  return db.transaction(() => {
    // Two-step claim respecting the concurrent-tournament cap:
    //   1. Try to claim from already-running tournaments (fair across them).
    //   2. If nothing claimable AND running count < cap, promote the oldest
    //      pending tournament and claim its first match.
    let row = db.prepare(`
      SELECT tm.id, tm.tournament_id FROM exhibition_tournament_match tm
      JOIN exhibition_tournament t ON t.id = tm.tournament_id
      WHERE tm.status = 'pending'
        AND tm.home_owned_fighter_id IS NOT NULL
        AND tm.away_owned_fighter_id IS NOT NULL
        AND t.status = 'running'
      ORDER BY
        (SELECT COUNT(*) FROM exhibition_tournament_match
         WHERE tournament_id = tm.tournament_id AND status = 'running') ASC,
        t.id ASC, tm.round ASC, tm.match_index ASC
      LIMIT 1
    `).get();
    if (!row) {
      const runningCount = db.prepare(
        `SELECT COUNT(*) AS n FROM exhibition_tournament WHERE status = 'running'`
      ).get().n;
      if (runningCount < maxConcurrent) {
        const next = db.prepare(
          `SELECT id FROM exhibition_tournament WHERE status = 'pending' ORDER BY id ASC LIMIT 1`
        ).get();
        if (next) {
          row = db.prepare(`
            SELECT id, tournament_id FROM exhibition_tournament_match
            WHERE tournament_id = ? AND status = 'pending'
              AND home_owned_fighter_id IS NOT NULL
              AND away_owned_fighter_id IS NOT NULL
            ORDER BY round, match_index LIMIT 1
          `).get(next.id);
        }
      }
    }
    if (!row) return null;
    const upd = db.prepare(
      `UPDATE exhibition_tournament_match SET status = 'running', worker_id = ?, started_at = datetime('now')
       WHERE id = ? AND status = 'pending'`
    ).run(workerId, row.id);
    if (upd.changes !== 1) return null;
    db.prepare(
      `UPDATE exhibition_tournament SET status = 'running', started_at = COALESCE(started_at, datetime('now'))
       WHERE id = ? AND status = 'pending'`
    ).run(row.tournament_id);
    return { id: row.id, tournament_id: row.tournament_id };
  })();
}

/**
 * After a match completes, fill in the corresponding side of the next-round
 * parent match. Match (r, m) feeds into (r+1, floor(m/2)): even m fills home,
 * odd m fills away. If we just completed the final, mark the tournament
 * complete and stamp the winner.
 */
function advanceTournamentBracket(db, matchId) {
  const m = db.prepare('SELECT * FROM exhibition_tournament_match WHERE id = ?').get(matchId);
  if (!m || m.status !== 'complete' || !m.winner_owned_fighter_id) return;
  const t = db.prepare('SELECT * FROM exhibition_tournament WHERE id = ?').get(m.tournament_id);
  const totalRounds = Math.log2(t.size);
  if (m.round + 1 >= totalRounds) {
    db.prepare(
      `UPDATE exhibition_tournament SET status = 'complete', winner_owned_fighter_id = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(m.winner_owned_fighter_id, t.id);
    // Bump the master fighter's tournament_wins so the profile reflects it.
    // We index on master, not owned_fighter, because two clones of the same
    // master should still credit the same character record.
    db.prepare(
      `UPDATE fighter SET tournament_wins = tournament_wins + 1
       WHERE id = (SELECT master_fighter_id FROM owned_fighter WHERE id = ?)`
    ).run(m.winner_owned_fighter_id);
    return;
  }
  const parentIdx = Math.floor(m.match_index / 2);
  const col = m.match_index % 2 === 0 ? 'home_owned_fighter_id' : 'away_owned_fighter_id';
  db.prepare(
    `UPDATE exhibition_tournament_match SET ${col} = ? WHERE tournament_id = ? AND round = ? AND match_index = ?`
  ).run(m.winner_owned_fighter_id, t.id, m.round + 1, parentIdx);
}

/**
 * Run a previously-claimed tournament match end-to-end. Same rules as a
 * regular exhibition (full life both sides, no stamina drain, master + owned
 * W/L/D updates), then advance the bracket. Draws are coin-flipped because
 * the tournament needs a winner to advance — TODO: replay or sudden-death.
 */
export async function runTournamentMatch(db, matchId, ctx) {
  const m = db.prepare('SELECT * FROM exhibition_tournament_match WHERE id = ?').get(matchId);
  if (!m) throw new Error(`tournament match ${matchId} not found`);
  const t = db.prepare(
    'SELECT rounds_per_fight, stage_id FROM exhibition_tournament WHERE id = ?'
  ).get(m.tournament_id);
  // Fixed stage if the user pinned one, otherwise random per match.
  let stageFile = null;
  if (t?.stage_id) {
    const s = db.prepare('SELECT file_name FROM stage WHERE id = ? AND active = 1').get(t.stage_id);
    stageFile = s?.file_name || null;
  }
  if (!stageFile) {
    const s = db.prepare(`SELECT file_name FROM stage WHERE active = 1 ORDER BY RANDOM() LIMIT 1`).get();
    stageFile = s ? s.file_name : null;
  }
  if (!stageFile) {
    db.prepare(
      `UPDATE exhibition_tournament_match SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`
    ).run('no active stage available', matchId);
    throw new Error('no active stage available');
  }
  try {
    const r = await runOwnedFighterMatch({
      db,
      homeOwnedFighterId: m.home_owned_fighter_id,
      awayOwnedFighterId: m.away_owned_fighter_id,
      stageFileName: stageFile,
      // Pass rounds_per_fight via ctx — match.js's launchEngine threads it
      // through to MATCH_ROUNDS env var for runMatch.sh / Ikemen.
      ctx: { ...ctx, rounds: t?.rounds_per_fight || 1 },
      affectStamina: false,
    });
    let winner = null;
    if (r.winner === 'fighter1') winner = m.home_owned_fighter_id;
    else if (r.winner === 'fighter2') winner = m.away_owned_fighter_id;
    if (winner === null) {
      // Coin-flip draws so the bracket can advance. Replay would be ideal.
      winner = Math.random() < 0.5 ? m.home_owned_fighter_id : m.away_owned_fighter_id;
    }
    db.prepare(
      `UPDATE exhibition_tournament_match SET status = 'complete', winner_owned_fighter_id = ?, result = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(winner, r.winner, matchId);
    advanceTournamentBracket(db, matchId);
    return { ok: true, result: r };
  } catch (err) {
    // Crash path: pick a winner by coin flip so the bracket still advances.
    // An unknown broken char is preferable to an indefinitely stuck
    // tournament. Match status flips to 'complete' so the supervisor moves
    // on, but `error` and result='crash' record what happened — the UI
    // surfaces the coin-flip icon with a "match crashed" tooltip.
    // No W/L/D bump (applyMatchOutcome was never reached) — neither fighter
    // actually fought.
    const flipWinner = Math.random() < 0.5 ? m.home_owned_fighter_id : m.away_owned_fighter_id;
    const upd = db.prepare(
      `UPDATE exhibition_tournament_match
         SET status = 'complete', winner_owned_fighter_id = ?, result = 'crash',
             error = ?, finished_at = datetime('now')
       WHERE id = ? AND status = 'running'`
    ).run(flipWinner, err.message?.slice(0, 500) || 'unknown', matchId);
    if (upd.changes === 1) advanceTournamentBracket(db, matchId);
    // Don't rethrow — the match is resolved (by coin flip), worker should
    // pick up the next one normally.
    return { ok: true, coinflip: true, error: err.message };
  }
}

/**
 * Crash recovery: any tournament match left 'running' from a previous boot
 * is reset to 'pending' so the runner can pick it up again. Tournaments
 * themselves stay 'running' since the bracket structure is intact.
 */
export function resetStuckTournamentMatches(db) {
  const r = db.prepare(
    `UPDATE exhibition_tournament_match SET status = 'pending', worker_id = NULL, started_at = NULL WHERE status = 'running'`
  ).run();
  return r.changes;
}

/**
 * Hydrate a tournament for the UI: tournament row + every match row + the
 * fighter display info needed to render the bracket without N+1 queries.
 * `was_coinflip` is derived: a complete match whose engine result was 'draw'
 * but with a winner_owned_fighter_id assigned can only have come from the
 * coin-flip tiebreaker.
 */
export function getExhibitionTournament(db, id) {
  const t = db.prepare(`
    SELECT t.*, s.display_name AS stage_display, s.file_name AS stage_file
    FROM exhibition_tournament t
    LEFT JOIN stage s ON s.id = t.stage_id
    WHERE t.id = ?
  `).get(id);
  if (!t) return null;
  const matches = db.prepare(`
    SELECT tm.*,
      hof.display_name AS home_name, ht.name AS home_team_name,
      aof.display_name AS away_name, at.name AS away_team_name,
      wof.display_name AS winner_name,
      (CASE WHEN tm.status = 'complete' AND tm.winner_owned_fighter_id IS NOT NULL AND tm.result IN ('draw', 'crash') THEN 1 ELSE 0 END) AS was_coinflip,
      (CASE WHEN tm.status = 'complete' AND tm.result = 'crash' THEN 1 ELSE 0 END) AS was_crash
    FROM exhibition_tournament_match tm
    LEFT JOIN owned_fighter hof ON hof.id = tm.home_owned_fighter_id
    LEFT JOIN team ht ON ht.id = hof.team_id
    LEFT JOIN owned_fighter aof ON aof.id = tm.away_owned_fighter_id
    LEFT JOIN team at ON at.id = aof.team_id
    LEFT JOIN owned_fighter wof ON wof.id = tm.winner_owned_fighter_id
    WHERE tm.tournament_id = ?
    ORDER BY tm.round, tm.match_index
  `).all(id);
  return { ...t, matches };
}

/**
 * Last N completed tournaments — for the "Recent" section of /tournaments.
 * Includes the full bracket so the page can render a final state.
 */
export function listRecentTournaments(db, limit = 5) {
  const rows = db.prepare(`
    SELECT t.id, u.username AS requester_username, u.is_bot AS requester_is_bot
    FROM exhibition_tournament t
    JOIN user_account u ON u.id = t.requester_user_id
    WHERE t.status = 'complete'
    ORDER BY t.finished_at DESC, t.id DESC
    LIMIT ?
  `).all(limit);
  return rows.map((r) => {
    const t = getExhibitionTournament(db, r.id);
    return t && { ...t, requester_username: r.requester_username, requester_is_bot: !!r.requester_is_bot };
  }).filter(Boolean);
}

/**
 * Tournaments a particular master fighter has won, newest first. Joins
 * through owned_fighter so it counts wins by any clone of the master.
 */
export function listTournamentWinsForMaster(db, masterFighterId, limit = 10) {
  return db.prepare(`
    SELECT t.id, t.size, t.rounds_per_fight, t.finished_at,
      u.username AS requester_username
    FROM exhibition_tournament t
    JOIN owned_fighter o ON o.id = t.winner_owned_fighter_id
    JOIN user_account u ON u.id = t.requester_user_id
    WHERE o.master_fighter_id = ? AND t.status = 'complete'
    ORDER BY t.finished_at DESC, t.id DESC
    LIMIT ?
  `).all(masterFighterId, limit);
}
