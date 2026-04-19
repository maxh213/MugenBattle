/**
 * League lifecycle: create a season, run fixtures, track standings.
 *
 * Model:
 *  - league (season) > divisions (tiers) > teams (round-robin inside a division).
 *  - A fixture = one tie between two teams, made up of 5 slot-by-slot matches.
 *  - Scoring: fixture win = 3 pts, draw = 1, loss = 0. Fixture winner is the
 *    side with more match wins out of 5 (ties allowed — 2-2 with 1 draw etc).
 *  - Stage: one per fixture, randomly selected from active stages; all 5
 *    slots in a fixture share it.
 *  - Lineups: selectLineup() is called at fixture-run time, so auto-rotate
 *    picks up fresh bench fighters mid-season.
 *
 * Forfeit: if a team can't field 5 active fighters, the other side takes a
 * 5-0 walkover. If neither can, the fixture records a 0-0 draw without
 * touching standings.
 */

import { pickActiveFighter, teamCanPlay } from './teams.js';
import { runOwnedFighterMatch } from './match.js';
import { credit } from './wallet.js';
import { seedBots } from './bots.js';

const PRIZE_WIN_CENTS = 50;
const PRIZE_DRAW_CENTS = 25;

/**
 * Best-effort: look for `chars/stg_<uuid>_<master>/something.(cns|cmd|st|lua)`
 * in the error. Ikemen's own parse/runtime errors reference the specific file
 * so the master in that path is almost certainly the culprit. If we can't
 * narrow it to exactly one master, do nothing.
 */
const CRASH_SUSPECT_THRESHOLD = 3;

/**
 * Mark a master inactive, retire every active clone, AND replace each
 * retired clone with a KFM training-dummy in the same slot so the team
 * stays at 5 active (or keeps its bench/for_sale slot filled). Without
 * the replacement, deactivating one bad master would drop every
 * affected team below 5 active → every future fixture forfeits.
 * Users can later release the KFM and buy a real replacement.
 */
function deactivateMaster(db, masterId, reason) {
  // Never deactivate the training dummy. KFM is the system's fallback char
  // and the replacement used for every retired clone — losing it would
  // break the whole mechanism.
  const m = db.prepare('SELECT file_name, is_unique FROM fighter WHERE id = ?').get(masterId);
  if (!m || m.file_name === 'kfm' || m.is_unique === 0) {
    return;
  }
  db.prepare(
    "UPDATE fighter SET active = 0, validated_at = datetime('now'), validation_reason = ? WHERE id = ?"
  ).run(reason, masterId);
  replaceClonesWithKfm(db, masterId, reason);
}

function replaceClonesWithKfm(db, masterId, reason) {
  const kfm = db.prepare("SELECT id FROM fighter WHERE file_name = 'kfm' AND is_master = 1").get();
  if (!kfm) return 0;
  const clones = db.prepare(
    'SELECT id, team_id, slot, priority FROM owned_fighter WHERE master_fighter_id = ? AND is_retired = 0'
  ).all(masterId);
  if (clones.length === 0) return 0;
  const retire = db.prepare('UPDATE owned_fighter SET is_retired = 1 WHERE id = ?');
  const insert = db.prepare(
    "INSERT INTO owned_fighter (team_id, master_fighter_id, display_name, slot, priority) VALUES (?, ?, 'Training Dummy', ?, ?)"
  );
  const history = db.prepare(
    'INSERT INTO owned_fighter_team_history (owned_fighter_id, team_id, reason) VALUES (?, ?, ?)'
  );
  for (const c of clones) {
    retire.run(c.id);
    const r = insert.run(c.team_id, kfm.id, c.slot, c.priority);
    history.run(r.lastInsertRowid, c.team_id, `kfm_replacement:${reason}`);
  }
  console.error(`[auto-deactivate] master #${masterId} (${reason}); ${clones.length} clone(s) replaced with KFM`);
  return clones.length;
}

export function replaceInactiveMasterClones(db) {
  // Called at boot. For any clone of an already-inactive master, swap in
  // a KFM so the team stays at 5 active instead of forfeiting.
  const bad = db.prepare(`
    SELECT DISTINCT master_fighter_id FROM owned_fighter
    WHERE is_retired = 0
      AND master_fighter_id IN (SELECT id FROM fighter WHERE is_master = 1 AND active = 0)
  `).all();
  let total = 0;
  for (const row of bad) {
    total += replaceClonesWithKfm(db, row.master_fighter_id, 'boot_sweep');
  }
  return total;
}

/**
 * Parse the error message for a chars/stg_<uuid>_<master>/ path. If exactly
 * one master is named, flip it inactive + retire its clones. Returns true
 * if a master was deactivated, false if we couldn't identify one.
 */
function deactivateIfIdentifiable(db, errMsg) {
  const deep = new Set();
  const re = /chars\/stg_[a-f0-9]+_([^/\s]+)\//g;
  let m;
  while ((m = re.exec(errMsg)) !== null) deep.add(m[1]);
  if (deep.size !== 1) return false;
  const [fileName] = deep;
  const row = db
    .prepare('SELECT id, active FROM fighter WHERE file_name = ? AND is_master = 1')
    .get(fileName);
  if (!row || row.active === 0) return true; // already deactivated, count as handled
  deactivateMaster(db, row.id, 'runtime_crash');
  return true;
}

/**
 * When we can't tell which combatant crashed (deep Ikemen panic with no
 * char path), bump a suspect counter on BOTH masters. Once a master hits
 * CRASH_SUSPECT_THRESHOLD, deactivate — any master consistently present
 * in mystery crashes is the likely cause.
 */
function chargeCrashSuspects(db, homeMasterId, awayMasterId) {
  const inc = db.prepare('UPDATE fighter SET crash_suspect_count = crash_suspect_count + 1 WHERE id = ?');
  const get = db.prepare('SELECT id, file_name, is_unique, crash_suspect_count, active FROM fighter WHERE id = ?');
  for (const mid of [homeMasterId, awayMasterId]) {
    if (!mid) continue;
    const row0 = get.get(mid);
    // KFM (non-unique training dummy) is the fallback and shows up in almost
    // every unidentifiable crash just by being present — never charge it.
    if (!row0 || row0.file_name === 'kfm' || row0.is_unique === 0) continue;
    inc.run(mid);
    const row = get.get(mid);
    if (row && row.active === 1 && row.crash_suspect_count >= CRASH_SUSPECT_THRESHOLD) {
      deactivateMaster(db, row.id, `repeated_crash:${row.crash_suspect_count}`);
    }
  }
}

/**
 * Create a season from an ordered list of divisions. Each division carries
 * its own list of team IDs (top division first = tier 1). Generates the
 * full fixture list up-front.
 *
 * divisions: [{ name, teamIds: number[] }, ...]
 * legs: 1 (default) = single round-robin. 2 = double (home+away legs).
 */
export function createSeason(db, { name, divisions, legs = 1, promotePerTier = 3 }) {
  if (!Array.isArray(divisions) || divisions.length === 0) {
    throw new Error('Season requires at least one division');
  }
  for (const d of divisions) {
    if (!Array.isArray(d.teamIds) || d.teamIds.length < 2) {
      throw new Error(`Division "${d.name}": needs at least 2 teams`);
    }
    const seen = new Set();
    for (const tid of d.teamIds) {
      if (seen.has(tid)) throw new Error(`Division "${d.name}": team ${tid} listed twice`);
      seen.add(tid);
      const team = db.prepare('SELECT id FROM team WHERE id = ?').get(tid);
      if (!team) throw new Error(`Division "${d.name}": team ${tid} not found`);
      const { n } = db.prepare(
        "SELECT COUNT(*) AS n FROM owned_fighter WHERE team_id = ? AND slot = 'active'"
      ).get(tid);
      if (n < 5) {
        throw new Error(`Team ${tid} has only ${n} active fighters (need 5)`);
      }
    }
  }

  const insertLeague = db.prepare(
    "INSERT INTO league (name, status, started_at, promote_per_tier) VALUES (?, 'running', datetime('now'), ?)"
  );
  const insertDivision = db.prepare(
    'INSERT INTO division (league_id, tier, name) VALUES (?, ?, ?)'
  );
  const insertDivTeam = db.prepare(
    'INSERT INTO division_team (division_id, team_id) VALUES (?, ?)'
  );
  const updateTeamLeague = db.prepare(
    'UPDATE team SET current_league_id = ? WHERE id = ?'
  );
  const insertFixture = db.prepare(`
    INSERT INTO fixture (division_id, round_num, slot_num, home_team_id, away_team_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const leagueId = insertLeague.run(name, promotePerTier).lastInsertRowid;
    for (let i = 0; i < divisions.length; i++) {
      const d = divisions[i];
      const divisionId = insertDivision.run(leagueId, i + 1, d.name).lastInsertRowid;
      for (const tid of d.teamIds) {
        insertDivTeam.run(divisionId, tid);
        updateTeamLeague.run(leagueId, tid);
      }
      const fixtures = roundRobinFixtures(d.teamIds, { legs });
      for (const f of fixtures) {
        insertFixture.run(divisionId, f.round, f.slot, f.home, f.away);
      }
    }
    return leagueId;
  });

  return tx();
}

/**
 * Classic circle-method round-robin. N teams → (N-1) rounds, ⌊N/2⌋ pairings
 * per round. Odd N: append a BYE (null) and skip pairings that involve it.
 * With legs=2, the second half mirrors the first with home/away swapped.
 */
export function roundRobinFixtures(teamIds, { legs = 1 } = {}) {
  const teams = [...teamIds];
  if (teams.length % 2 === 1) teams.push(null);
  const n = teams.length;
  const rounds = n - 1;
  const half = n / 2;

  const firstLeg = [];
  let rotation = teams.slice(1);
  for (let r = 0; r < rounds; r++) {
    const layout = [teams[0], ...rotation];
    let slot = 0;
    for (let i = 0; i < half; i++) {
      const a = layout[i];
      const b = layout[n - 1 - i];
      if (a === null || b === null) continue;
      // alternate home/away across rounds + positions for a balanced schedule
      const flip = (r + i) % 2 === 1;
      const home = flip ? b : a;
      const away = flip ? a : b;
      firstLeg.push({ round: r + 1, slot: ++slot, home, away });
    }
    rotation = [rotation[rotation.length - 1], ...rotation.slice(0, -1)];
  }

  if (legs === 1) return firstLeg;

  const secondLeg = firstLeg.map((f) => ({
    round: f.round + rounds,
    slot: f.slot,
    home: f.away,
    away: f.home,
  }));
  return [...firstLeg, ...secondLeg];
}

/** Oldest pending fixture. Can be scoped by leagueId, divisionId, or both. */
export function pickNextFixture(db, { leagueId, divisionId } = {}) {
  const clauses = ["f.status = 'pending'", "l.status = 'running'"];
  const params = [];
  if (leagueId != null) { clauses.push('l.id = ?'); params.push(leagueId); }
  if (divisionId != null) { clauses.push('f.division_id = ?'); params.push(divisionId); }
  return db.prepare(`
    SELECT f.*
    FROM fixture f
    JOIN division d ON f.division_id = d.id
    JOIN league l ON d.league_id = l.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY d.tier, f.round_num, f.slot_num, f.id LIMIT 1
  `).get(...params);
}

const BEST_OF_ROUNDS = 3;

export async function runFixture(db, fixtureId, ctx) {
  const fixture = db.prepare('SELECT * FROM fixture WHERE id = ?').get(fixtureId);
  if (!fixture) throw new Error(`Fixture ${fixtureId} not found`);
  if (fixture.status !== 'pending') {
    throw new Error(`Fixture ${fixtureId} is ${fixture.status}, not pending`);
  }

  // Either team without a playable active roster forfeits the fixture.
  const homeCanPlay = teamCanPlay(db, fixture.home_team_id);
  const awayCanPlay = teamCanPlay(db, fixture.away_team_id);
  if (!homeCanPlay || !awayCanPlay) {
    return forfeitFixture(db, fixture, !homeCanPlay, !awayCanPlay);
  }

  const home = pickActiveFighter(db, fixture.home_team_id);
  const away = pickActiveFighter(db, fixture.away_team_id);
  if (!home || !away) return forfeitFixture(db, fixture, !home, !away);

  // Prefer the home team's owned stage ("home advantage"); otherwise pick a
  // random active stage from the pool.
  let stageRow = db.prepare(
    'SELECT id, file_name FROM stage WHERE active = 1 AND owner_team_id = ? LIMIT 1'
  ).get(fixture.home_team_id);
  if (!stageRow) {
    stageRow = db.prepare(
      'SELECT id, file_name FROM stage WHERE active = 1 ORDER BY RANDOM() LIMIT 1'
    ).get();
  }
  if (!stageRow) throw new Error('No active stages available');

  db.prepare(
    "UPDATE fixture SET status = 'running', stage_id = ?, started_at = datetime('now') WHERE id = ?"
  ).run(stageRow.id, fixture.id);

  // Pre-insert the fixture_match row so live-context queries can surface
  // the picked fighters during the match. Finalise updates rounds + winner.
  db.prepare(`
    INSERT INTO fixture_match
      (fixture_id, slot, home_owned_fighter_id, away_owned_fighter_id, stage_id,
       home_rounds, away_rounds, winner)
    VALUES (?, 1, ?, ?, ?, 0, 0, 'draw')
  `).run(fixture.id, home.id, away.id, stageRow.id);

  let r;
  try {
    r = await runOwnedFighterMatch({
      db,
      homeOwnedFighterId: home.id,
      awayOwnedFighterId: away.id,
      stageFileName: stageRow.file_name,
      ctx: { ...(ctx || {}), rounds: BEST_OF_ROUNDS },
    });
  } catch (err) {
    console.error(`[fixture ${fixture.id}] match error: ${err.message.split('\n')[0]}`);
    r = { winner: 'draw', fighter1Rounds: 0, fighter2Rounds: 0 };
    const identified = deactivateIfIdentifiable(db, err.message || '');
    if (!identified) {
      chargeCrashSuspects(db, home.master_fighter_id, away.master_fighter_id);
    }
  }

  const homeRounds = r.fighter1Rounds || 0;
  const awayRounds = r.fighter2Rounds || 0;
  const winner = r.winner === 'fighter1' ? 'home'
    : r.winner === 'fighter2' ? 'away'
    : 'draw';
  const winnerTeamId = winner === 'home' ? fixture.home_team_id
    : winner === 'away' ? fixture.away_team_id
    : null;

  const finalize = db.transaction(() => {
    db.prepare(`
      UPDATE fixture_match SET home_rounds = ?, away_rounds = ?, winner = ?
      WHERE fixture_id = ? AND slot = 1
    `).run(homeRounds, awayRounds, winner, fixture.id);

    db.prepare(`
      UPDATE fixture SET status = 'complete', home_score = ?, away_score = ?,
        winner_team_id = ?, finished_at = datetime('now') WHERE id = ?
    `).run(homeRounds, awayRounds, winnerTeamId, fixture.id);

    // consecutive_losses per owned_fighter: reset on win/draw, +1 on loss.
    updateLossStreak(db, home.id, winner === 'home' ? 'won' : winner === 'away' ? 'lost' : 'drawn');
    updateLossStreak(db, away.id, winner === 'away' ? 'won' : winner === 'home' ? 'lost' : 'drawn');

    updateStandings(db, fixture.division_id, fixture.home_team_id, fixture.away_team_id, homeRounds, awayRounds, winnerTeamId);
    awardPrize(db, fixture.id, fixture.home_team_id, fixture.away_team_id, winnerTeamId);
    maybeCompleteLeague(db, fixture.division_id);
  });
  finalize();

  return {
    fixture: { ...fixture, home_score: homeRounds, away_score: awayRounds, winner_team_id: winnerTeamId },
    home: { id: home.id, name: home.display_name },
    away: { id: away.id, name: away.display_name },
    homeRounds, awayRounds, winner, winnerTeamId,
    stage: stageRow.file_name,
  };
}

function updateLossStreak(db, ownedFighterId, result) {
  if (result === 'lost') {
    db.prepare('UPDATE owned_fighter SET consecutive_losses = consecutive_losses + 1 WHERE id = ?').run(ownedFighterId);
  } else {
    db.prepare('UPDATE owned_fighter SET consecutive_losses = 0 WHERE id = ?').run(ownedFighterId);
  }
}

function forfeitFixture(db, fixture, homeShort, awayShort) {
  let homeRounds = 0, awayRounds = 0, winnerTeamId = null;
  if (homeShort && awayShort) {
    // nothing — record as 0-0 no-contest
  } else if (homeShort) {
    awayRounds = 2; winnerTeamId = fixture.away_team_id;
  } else {
    homeRounds = 2; winnerTeamId = fixture.home_team_id;
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE fixture SET status = 'complete', home_score = ?, away_score = ?,
        winner_team_id = ?, started_at = COALESCE(started_at, datetime('now')),
        finished_at = datetime('now') WHERE id = ?
    `).run(homeRounds, awayRounds, winnerTeamId, fixture.id);
    if (!(homeShort && awayShort)) {
      updateStandings(db, fixture.division_id, fixture.home_team_id, fixture.away_team_id, homeRounds, awayRounds, winnerTeamId);
    }
    maybeCompleteLeague(db, fixture.division_id);
  });
  tx();

  return { fixture, homeRounds, awayRounds, winnerTeamId, forfeit: true };
}

/**
 * Prize money per fixture result. Credited to the team's owning user's
 * wallet (bots included — they accumulate cash that simply never spends).
 * Win = PRIZE_WIN_CENTS; draw = PRIZE_DRAW_CENTS each; loss = 0.
 */
function awardPrize(db, fixtureId, homeTeamId, awayTeamId, winnerTeamId) {
  const homeUser = db.prepare('SELECT user_id FROM team WHERE id = ?').get(homeTeamId)?.user_id;
  const awayUser = db.prepare('SELECT user_id FROM team WHERE id = ?').get(awayTeamId)?.user_id;
  if (winnerTeamId === homeTeamId) {
    if (homeUser) credit(db, homeUser, PRIZE_WIN_CENTS, 'fixture_win', fixtureId);
  } else if (winnerTeamId === awayTeamId) {
    if (awayUser) credit(db, awayUser, PRIZE_WIN_CENTS, 'fixture_win', fixtureId);
  } else {
    if (homeUser) credit(db, homeUser, PRIZE_DRAW_CENTS, 'fixture_draw', fixtureId);
    if (awayUser) credit(db, awayUser, PRIZE_DRAW_CENTS, 'fixture_draw', fixtureId);
  }
}

function updateStandings(db, divisionId, homeId, awayId, homeScore, awayScore, winnerTeamId) {
  // For 1v1 best-of-3 fixtures, winnerTeamId is authoritative; home/away
  // rounds only feed the match-W-L tiebreaker columns. Draw = scores tied
  // AND no winnerTeamId (both teams short-forfeit or live draw).
  const homeWon = winnerTeamId === homeId;
  const awayWon = winnerTeamId === awayId;
  const drawn = !homeWon && !awayWon;

  const apply = db.prepare(`
    UPDATE division_team
    SET points = points + ?,
        fixtures_played = fixtures_played + 1,
        fixtures_won = fixtures_won + ?,
        fixtures_drawn = fixtures_drawn + ?,
        fixtures_lost = fixtures_lost + ?,
        matches_won = matches_won + ?,
        matches_lost = matches_lost + ?
    WHERE division_id = ? AND team_id = ?
  `);
  apply.run(
    homeWon ? 3 : drawn ? 1 : 0,
    homeWon ? 1 : 0, drawn ? 1 : 0, awayWon ? 1 : 0,
    homeScore, awayScore,
    divisionId, homeId
  );
  apply.run(
    awayWon ? 3 : drawn ? 1 : 0,
    awayWon ? 1 : 0, drawn ? 1 : 0, homeWon ? 1 : 0,
    awayScore, homeScore,
    divisionId, awayId
  );
}

function maybeCompleteLeague(db, divisionId) {
  const { league_id } = db.prepare('SELECT league_id FROM division WHERE id = ?').get(divisionId);
  const { n } = db.prepare(`
    SELECT COUNT(*) AS n FROM fixture f
    JOIN division d ON f.division_id = d.id
    WHERE d.league_id = ? AND f.status != 'complete'
  `).get(league_id);
  if (n === 0) {
    db.prepare("UPDATE league SET status = 'complete', finished_at = datetime('now') WHERE id = ?").run(league_id);
    // Release all teams so they're eligible for the next season.
    db.prepare('UPDATE team SET current_league_id = NULL WHERE current_league_id = ?').run(league_id);
    // Retire every bot roster in this league — unique masters flow back to
    // the unclaimed pool so new signups / next-season bots can draw fresh.
    db.prepare(`
      UPDATE owned_fighter SET is_retired = 1
      WHERE is_retired = 0
        AND team_id IN (
          SELECT t.id FROM team t
          JOIN user_account u ON t.user_id = u.id
          WHERE u.is_bot = 1
        )
    `).run();
  }
}

export function getStandings(db, leagueId) {
  const league = db.prepare('SELECT * FROM league WHERE id = ?').get(leagueId);
  if (!league) return null;
  const divisions = db.prepare('SELECT * FROM division WHERE league_id = ? ORDER BY tier').all(leagueId);
  const withStandings = divisions.map((d) => {
    const base = db.prepare(`
      SELECT dt.*, t.name AS team_name, u.username
      FROM division_team dt
      JOIN team t ON dt.team_id = t.id
      JOIN user_account u ON t.user_id = u.id
      WHERE dt.division_id = ?
      ORDER BY dt.points DESC,
               (dt.matches_won - dt.matches_lost) DESC,
               dt.matches_won DESC,
               dt.fixtures_played ASC,
               t.name ASC
    `).all(d.id);
    return { ...d, standings: applyHeadToHead(db, base) };
  });
  const pending = db.prepare(`
    SELECT COUNT(*) AS n FROM fixture f
    JOIN division d ON f.division_id = d.id
    WHERE d.league_id = ? AND f.status != 'complete'
  `).get(leagueId).n;
  return { league, divisions: withStandings, pending };
}

/**
 * Re-rank any run of teams still tied on (points, match-diff, match-wins)
 * by a mini-league of just their head-to-head fixtures. Matches the
 * Premier League's 4th-tiebreaker rule. Teams that aren't in a tied run
 * stay in their base-sort position.
 */
function applyHeadToHead(db, rows) {
  if (rows.length < 2) return rows;
  const out = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (
      j < rows.length &&
      rows[j].points === rows[i].points &&
      (rows[j].matches_won - rows[j].matches_lost) === (rows[i].matches_won - rows[i].matches_lost) &&
      rows[j].matches_won === rows[i].matches_won
    ) j++;
    if (j === i + 1) {
      out.push(rows[i]);
    } else {
      const group = rows.slice(i, j);
      out.push(...sortByHeadToHead(db, group));
    }
    i = j;
  }
  return out;
}

function sortByHeadToHead(db, group) {
  const ids = group.map((g) => g.team_id);
  const placeholders = ids.map(() => '?').join(',');
  const fixtures = db.prepare(`
    SELECT home_team_id, away_team_id, home_score, away_score, winner_team_id
    FROM fixture
    WHERE status = 'complete'
      AND home_team_id IN (${placeholders})
      AND away_team_id IN (${placeholders})
  `).all(...ids, ...ids);

  const mini = new Map(ids.map((id) => [id, { points: 0, wins: 0, losses: 0 }]));
  for (const f of fixtures) {
    const h = mini.get(f.home_team_id);
    const a = mini.get(f.away_team_id);
    h.wins += f.home_score; h.losses += f.away_score;
    a.wins += f.away_score; a.losses += f.home_score;
    if (f.winner_team_id === f.home_team_id) h.points += 3;
    else if (f.winner_team_id === f.away_team_id) a.points += 3;
    else { h.points += 1; a.points += 1; }
  }

  return group.slice().sort((ra, rb) => {
    const a = mini.get(ra.team_id);
    const b = mini.get(rb.team_id);
    if (a.points !== b.points) return b.points - a.points;
    const ad = a.wins - a.losses;
    const bd = b.wins - b.losses;
    if (ad !== bd) return bd - ad;
    if (a.wins !== b.wins) return b.wins - a.wins;
    return (ra.team_name || '').localeCompare(rb.team_name || '');
  });
}

/**
 * Rich snapshot of what's currently playing for a worker driving this league.
 * With a divisionId, scoped to just that tier — needed when multiple workers
 * run different divisions of the same league in parallel.
 * Returns null if the league has no in-progress fixture in-scope. Used by
 * the /leagues dashboard to overlay team names, slot progress, stage etc.
 */
export function getLiveLeagueContext(db, leagueId, divisionId = null) {
  const league = db.prepare('SELECT id, name, status FROM league WHERE id = ?').get(leagueId);
  if (!league) return null;

  const clauses = ["d.league_id = ?", "f.status = 'running'"];
  const params = [leagueId];
  if (divisionId != null) { clauses.push('f.division_id = ?'); params.push(divisionId); }
  const fixture = db.prepare(`
    SELECT f.*,
      h.name AS home_name, a.name AS away_name,
      d.tier, d.name AS division_name,
      s.file_name AS stage_file, s.display_name AS stage_display
    FROM fixture f
    JOIN division d ON f.division_id = d.id
    JOIN team h ON f.home_team_id = h.id
    JOIN team a ON f.away_team_id = a.id
    LEFT JOIN stage s ON f.stage_id = s.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY f.id LIMIT 1
  `).get(...params);

  if (!fixture) return { league, fixture: null };

  // New format: one match per fixture, best-of-3. Before the match completes,
  // fixture_match has no row yet — overlay shows who was picked via the
  // team's rotation rules for fresher info. After, it's the stored winner.
  const matchRow = db.prepare(`
    SELECT fm.home_rounds, fm.away_rounds, fm.winner,
      oh.display_name AS home_fighter,
      oa.display_name AS away_fighter,
      hf.file_name AS home_master,
      af.file_name AS away_master
    FROM fixture_match fm
    JOIN owned_fighter oh ON oh.id = fm.home_owned_fighter_id
    JOIN owned_fighter oa ON oa.id = fm.away_owned_fighter_id
    JOIN fighter hf ON hf.id = oh.master_fighter_id
    JOIN fighter af ON af.id = oa.master_fighter_id
    WHERE fm.fixture_id = ? ORDER BY fm.slot LIMIT 1
  `).get(fixture.id);

  return {
    league,
    fixture: {
      id: fixture.id,
      round: fixture.round_num,
      slot_num: fixture.slot_num,
      home_team: fixture.home_name,
      away_team: fixture.away_name,
      division: { tier: fixture.tier, name: fixture.division_name },
      stage: fixture.stage_display || fixture.stage_file,
      home_rounds: matchRow?.home_rounds ?? 0,
      away_rounds: matchRow?.away_rounds ?? 0,
      home_fighter: matchRow?.home_fighter ?? null,
      away_fighter: matchRow?.away_fighter ?? null,
      home_master: matchRow?.home_master ?? null,
      away_master: matchRow?.away_master ?? null,
      completed: !!matchRow,
    },
  };
}

/**
 * Given the most-recent completed league, compute the next season's seating
 * by standard promotion/relegation:
 *   - top K of each tier promote up (tier 1 stays at tier 1)
 *   - bottom K of each tier relegate down
 *   - bottom K of the BOTTOM tier drop out (returned as `dropped` — caller
 *     leaves them at current_league_id=NULL so they wait for the next cycle).
 *
 * Returns { divisions: [{name, teamIds:[]}, ...], dropped: [teamIds] }
 * with divCount tiers. Each tier's teamIds may be < perDiv — the caller fills
 * gaps with bots + new signups.
 *
 * Returns null if there's no prior completed league (fresh-start case).
 * Assumes the new season's divCount matches the prev league's divCount;
 * falls back to null if they differ.
 */
export function computeNextSeasonSeating(db, { divCount, perDiv, promotePerTier = 2 }) {
  const prev = db.prepare(`
    SELECT id FROM league WHERE status = 'complete' ORDER BY id DESC LIMIT 1
  `).get();
  if (!prev) return null;

  const prevDivs = db.prepare(`
    SELECT id, tier FROM division WHERE league_id = ? ORDER BY tier
  `).all(prev.id);
  if (prevDivs.length !== divCount) return null;

  const standingsByTier = {};
  for (const d of prevDivs) {
    standingsByTier[d.tier] = db.prepare(`
      SELECT dt.team_id FROM division_team dt
      WHERE dt.division_id = ?
      ORDER BY dt.points DESC,
               (dt.matches_won - dt.matches_lost) DESC,
               dt.matches_won DESC,
               dt.fixtures_played ASC,
               dt.team_id
    `).all(d.id).map((r) => r.team_id);
  }

  const divisions = [];
  for (let i = 0; i < divCount; i++) {
    divisions.push({ name: `Division ${i + 1}`, teamIds: [] });
  }
  const dropped = [];

  for (let tier = 1; tier <= divCount; tier++) {
    const rows = standingsByTier[tier] || [];
    // Don't promote more than we can meaningfully partition — if a division
    // only had 2 teams and promotePerTier=2, halve it so mid isn't empty.
    const K = Math.max(0, Math.min(promotePerTier, Math.floor(rows.length / 2)));
    const topK = K > 0 ? rows.slice(0, K) : [];
    const bottomK = K > 0 ? rows.slice(-K) : [];
    const mid = K > 0 ? rows.slice(K, rows.length - K) : rows;

    // stayers and promotees
    if (tier === 1) {
      divisions[0].teamIds.push(...topK, ...mid);
      if (divCount >= 2) divisions[1].teamIds.push(...bottomK);
      else divisions[0].teamIds.push(...bottomK);
    } else if (tier === divCount) {
      divisions[tier - 2].teamIds.push(...topK);
      divisions[tier - 1].teamIds.push(...mid);
      dropped.push(...bottomK);
    } else {
      divisions[tier - 2].teamIds.push(...topK);
      divisions[tier - 1].teamIds.push(...mid);
      divisions[tier].teamIds.push(...bottomK);
    }
  }

  return { divisions, dropped };
}

/**
 * Create the next season end-to-end: seat returning teams per prev-season
 * standings (promotion/relegation), route new signups into the bottom tier,
 * top up bots to fill remaining slots, and insert the fixture list.
 *
 * Returns { leagueId, name, divisions, totalSlots, realSeated, waitingReal,
 * botsUsed, dropped } on success, or null if we couldn't fill the bracket
 * (shouldn't happen once bots are seeded but handled defensively).
 *
 * The CLI wraps this with nicer logging; the stream-server supervisor
 * calls it on each empty-league tick when STREAM_AUTO_SEASONS=1.
 */
export function autoCreateSeason(db, {
  divCount = 3,
  perDiv = 20,
  legs = 2,
  promotePerTier = 3,
  seasonName = null,
} = {}) {
  const totalSlots = divCount * perDiv;

  const pr = computeNextSeasonSeating(db, { divCount, perDiv, promotePerTier });
  const divisions = pr
    ? pr.divisions.map((d) => ({ name: d.name, teamIds: [...d.teamIds] }))
    : Array.from({ length: divCount }, (_, i) => ({ name: `Division ${i + 1}`, teamIds: [] }));
  const dropped = pr ? [...pr.dropped] : [];
  const alreadySeated = new Set(divisions.flatMap((d) => d.teamIds));
  const excluded = new Set([...alreadySeated, ...dropped]);

  const newRealTeams = db.prepare(`
    SELECT t.id FROM team t
    JOIN user_account u ON t.user_id = u.id
    WHERE u.is_bot = 0
      AND t.current_league_id IS NULL
      AND (SELECT COUNT(*) FROM owned_fighter WHERE team_id = t.id AND is_retired = 0 AND slot = 'active') >= 5
    ORDER BY t.id
  `).all().map((r) => r.id).filter((id) => !excluded.has(id));

  const bottom = divisions[divCount - 1];
  const newSeated = [];
  while (newRealTeams.length && bottom.teamIds.length < perDiv) {
    const id = newRealTeams.shift();
    bottom.teamIds.push(id);
    newSeated.push(id);
  }
  const waitingReal = newRealTeams.length;

  const gaps = divisions.reduce((sum, d) => sum + (perDiv - d.teamIds.length), 0);
  // Seed enough bots that AFTER excluding prev-season-dropped bots we still
  // have `gaps` available. currentBotCount + gaps guarantees `gaps` fresh
  // additions; existing-eligible bots make it spare.
  const currentBotCount = db.prepare('SELECT COUNT(*) AS n FROM user_account WHERE is_bot = 1').get().n;
  const allBots = seedBots(db, currentBotCount + Math.max(1, gaps));
  const botIdsReady = allBots
    .filter((b) => {
      const t = db.prepare('SELECT current_league_id FROM team WHERE id = ?').get(b.team_id);
      return t.current_league_id == null && !excluded.has(b.team_id);
    })
    .map((b) => b.team_id);

  let botIdx = 0;
  for (const d of divisions) {
    while (d.teamIds.length < perDiv && botIdx < botIdsReady.length) {
      d.teamIds.push(botIdsReady[botIdx++]);
    }
  }
  const botsUsed = botIdx;
  const totalFilled = divisions.reduce((s, d) => s + d.teamIds.length, 0);
  if (totalFilled < totalSlots) return null;

  const name = seasonName
    || `Season ${new Date().toISOString().slice(0, 10)} #${Date.now().toString(36).slice(-4)}`;
  const leagueId = createSeason(db, { name, divisions, legs, promotePerTier });
  return {
    leagueId,
    name,
    divisions,
    totalSlots,
    newSeated: newSeated.length,
    waitingReal,
    botsUsed,
    dropped,
    hadPrevSeason: !!pr,
  };
}

/**
 * Recent fixture_match slots for a given owned_fighter. Returns one row
 * per match it played, with the opponent's display name and the outcome
 * from this fighter's point of view ('won' | 'lost' | 'drawn').
 */
export function ownedFighterHistory(db, ownedFighterId, limit = 20) {
  return db.prepare(`
    SELECT fm.id, fm.slot, fm.played_at, fm.winner,
      fm.home_owned_fighter_id, fm.away_owned_fighter_id,
      fm.home_rounds, fm.away_rounds,
      CASE WHEN fm.home_owned_fighter_id = ? THEN 'home' ELSE 'away' END AS side,
      CASE
        WHEN fm.home_owned_fighter_id = ? THEN oa.display_name
        ELSE oh.display_name
      END AS opponent,
      CASE
        WHEN fm.home_owned_fighter_id = ? THEN ta.name
        ELSE th.name
      END AS opponent_team,
      s.display_name AS stage,
      f.id AS fixture_id, f.division_id
    FROM fixture_match fm
    JOIN fixture f ON fm.fixture_id = f.id
    JOIN owned_fighter oh ON fm.home_owned_fighter_id = oh.id
    JOIN owned_fighter oa ON fm.away_owned_fighter_id = oa.id
    JOIN team th ON oh.team_id = th.id
    JOIN team ta ON oa.team_id = ta.id
    JOIN stage s ON fm.stage_id = s.id
    WHERE fm.home_owned_fighter_id = ? OR fm.away_owned_fighter_id = ?
    ORDER BY fm.id DESC LIMIT ?
  `).all(ownedFighterId, ownedFighterId, ownedFighterId, ownedFighterId, ownedFighterId, limit);
}

/**
 * Upcoming + recently-finished fixtures for a team in its current league.
 * Upcoming = status='pending' or 'running', by round+slot. Recent = most
 * recent 5 completed.
 */
export function teamSchedule(db, teamId) {
  const team = db.prepare('SELECT current_league_id FROM team WHERE id = ?').get(teamId);
  if (!team || !team.current_league_id) return { upcoming: [], recent: [], league_id: null };
  const select = `
    SELECT f.id, f.round_num, f.slot_num, f.status, f.home_score, f.away_score,
      f.winner_team_id, f.home_team_id, f.away_team_id,
      h.name AS home_name, a.name AS away_name,
      d.tier, d.name AS division_name,
      s.display_name AS stage
    FROM fixture f
    JOIN division d ON f.division_id = d.id
    JOIN team h ON f.home_team_id = h.id
    JOIN team a ON f.away_team_id = a.id
    LEFT JOIN stage s ON f.stage_id = s.id
  `;
  const upcoming = db.prepare(
    `${select} WHERE d.league_id = ? AND (f.home_team_id = ? OR f.away_team_id = ?) AND f.status != 'complete' ORDER BY f.round_num, f.slot_num, f.id`
  ).all(team.current_league_id, teamId, teamId);
  const recent = db.prepare(
    `${select} WHERE d.league_id = ? AND (f.home_team_id = ? OR f.away_team_id = ?) AND f.status = 'complete' ORDER BY f.id DESC LIMIT 5`
  ).all(team.current_league_id, teamId, teamId);
  return { upcoming, recent, league_id: team.current_league_id };
}

/**
 * ID of the "currently interesting" league: the latest running one, else
 * the latest complete one, else null. Used by the pyramid view.
 */
export function latestInterestingLeagueId(db) {
  const running = db.prepare(
    "SELECT id FROM league WHERE status = 'running' ORDER BY id DESC LIMIT 1"
  ).get();
  if (running) return running.id;
  const complete = db.prepare(
    "SELECT id FROM league WHERE status = 'complete' ORDER BY id DESC LIMIT 1"
  ).get();
  return complete?.id ?? null;
}

/**
 * Everything the /live Tier N view needs in a single query. Returns null
 * when there's no league to show.
 */
export function getLiveTierView(db, tier) {
  const leagueRow = db.prepare(
    "SELECT id, name, promote_per_tier FROM league WHERE status = 'running' ORDER BY id DESC LIMIT 1"
  ).get() || db.prepare(
    "SELECT id, name, promote_per_tier FROM league WHERE status = 'complete' ORDER BY id DESC LIMIT 1"
  ).get();
  if (!leagueRow) return null;

  const division = db.prepare(
    'SELECT * FROM division WHERE league_id = ? AND tier = ? LIMIT 1'
  ).get(leagueRow.id, tier);
  if (!division) return null;

  const fighter = (ownedId) => {
    if (!ownedId) return null;
    return db.prepare(`
      SELECT of.id, of.display_name, of.matches_won, of.matches_lost, of.matches_drawn,
        of.stamina, of.stamina_updated_at,
        f.file_name AS master_file_name, f.display_name AS master_display_name
      FROM owned_fighter of
      JOIN fighter f ON of.master_fighter_id = f.id
      WHERE of.id = ?
    `).get(ownedId);
  };

  // Current running fixture (if any) — populated with fighter info via the
  // pre-inserted fixture_match row.
  const running = db.prepare(`
    SELECT f.id, f.round_num, f.slot_num, f.home_team_id, f.away_team_id,
      f.home_score AS home_rounds, f.away_score AS away_rounds,
      h.name AS home_team_name, a.name AS away_team_name,
      hu.username AS home_username, au.username AS away_username,
      s.display_name AS stage_display, s.file_name AS stage_file,
      fm.home_owned_fighter_id, fm.away_owned_fighter_id,
      fm.home_rounds AS round_home, fm.away_rounds AS round_away
    FROM fixture f
    JOIN team h ON f.home_team_id = h.id
    JOIN team a ON f.away_team_id = a.id
    JOIN user_account hu ON h.user_id = hu.id
    JOIN user_account au ON a.user_id = au.id
    LEFT JOIN stage s ON f.stage_id = s.id
    LEFT JOIN fixture_match fm ON fm.fixture_id = f.id AND fm.slot = 1
    WHERE f.division_id = ? AND f.status = 'running'
    ORDER BY f.id DESC LIMIT 1
  `).get(division.id);

  const current = running ? {
    fixture_id: running.id,
    round: running.round_num,
    stage: running.stage_display || running.stage_file || null,
    home_rounds: running.round_home ?? 0,
    away_rounds: running.round_away ?? 0,
    home: {
      team_id: running.home_team_id,
      team_name: running.home_team_name,
      username: running.home_username,
      fighter: fighter(running.home_owned_fighter_id),
    },
    away: {
      team_id: running.away_team_id,
      team_name: running.away_team_name,
      username: running.away_username,
      fighter: fighter(running.away_owned_fighter_id),
    },
  } : null;

  // Next 5 pending fixtures.
  const upcoming = db.prepare(`
    SELECT f.id, f.round_num, h.name AS home_team_name, a.name AS away_team_name
    FROM fixture f
    JOIN team h ON f.home_team_id = h.id
    JOIN team a ON f.away_team_id = a.id
    WHERE f.division_id = ? AND f.status = 'pending'
    ORDER BY f.round_num, f.slot_num, f.id
    LIMIT 5
  `).all(division.id);

  // Last 8 complete fixtures with the fighter used by each side.
  const recent = db.prepare(`
    SELECT f.id, f.round_num, f.home_score AS home_rounds, f.away_score AS away_rounds,
      f.winner_team_id, f.finished_at,
      h.name AS home_team_name, a.name AS away_team_name,
      oh.display_name AS home_fighter, oa.display_name AS away_fighter
    FROM fixture f
    JOIN team h ON f.home_team_id = h.id
    JOIN team a ON f.away_team_id = a.id
    LEFT JOIN fixture_match fm ON fm.fixture_id = f.id AND fm.slot = 1
    LEFT JOIN owned_fighter oh ON oh.id = fm.home_owned_fighter_id
    LEFT JOIN owned_fighter oa ON oa.id = fm.away_owned_fighter_id
    WHERE f.division_id = ? AND f.status = 'complete'
    ORDER BY f.finished_at DESC, f.id DESC
    LIMIT 8
  `).all(division.id);

  // Standings for this tier only.
  const standings = db.prepare(`
    SELECT dt.*, t.name AS team_name, u.username
    FROM division_team dt
    JOIN team t ON dt.team_id = t.id
    JOIN user_account u ON t.user_id = u.id
    WHERE dt.division_id = ?
    ORDER BY dt.points DESC,
             (dt.matches_won - dt.matches_lost) DESC,
             dt.matches_won DESC,
             dt.fixtures_played ASC,
             t.name ASC
  `).all(division.id);

  return {
    league: leagueRow,
    division: { tier: division.tier, name: division.name, id: division.id },
    current,
    upcoming,
    recent,
    standings,
  };
}

export function listLeagues(db) {
  return db.prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM division WHERE league_id = l.id) AS division_count,
      (SELECT COUNT(*) FROM fixture f JOIN division d ON f.division_id = d.id WHERE d.league_id = l.id) AS fixture_count,
      (SELECT COUNT(*) FROM fixture f JOIN division d ON f.division_id = d.id
        WHERE d.league_id = l.id AND f.status = 'complete') AS fixtures_done
    FROM league l
    ORDER BY l.id DESC
  `).all();
}
