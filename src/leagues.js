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

import { selectLineup } from './teams.js';
import { runOwnedFighterMatch } from './match.js';

/**
 * Create a season from an ordered list of divisions. Each division carries
 * its own list of team IDs (top division first = tier 1). Generates the
 * full fixture list up-front.
 *
 * divisions: [{ name, teamIds: number[] }, ...]
 * legs: 1 (default) = single round-robin. 2 = double (home+away legs).
 */
export function createSeason(db, { name, divisions, legs = 1 }) {
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
    "INSERT INTO league (name, status, started_at) VALUES (?, 'running', datetime('now'))"
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
    const leagueId = insertLeague.run(name).lastInsertRowid;
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

/** Oldest pending fixture across all running leagues, top division first. */
export function pickNextFixture(db, { leagueId } = {}) {
  const base = `
    SELECT f.*
    FROM fixture f
    JOIN division d ON f.division_id = d.id
    JOIN league l ON d.league_id = l.id
    WHERE f.status = 'pending' AND l.status = 'running'
  `;
  if (leagueId != null) {
    return db.prepare(`${base} AND l.id = ? ORDER BY d.tier, f.round_num, f.slot_num, f.id LIMIT 1`).get(leagueId);
  }
  return db.prepare(`${base} ORDER BY d.tier, f.round_num, f.slot_num, f.id LIMIT 1`).get();
}

export async function runFixture(db, fixtureId) {
  const fixture = db.prepare('SELECT * FROM fixture WHERE id = ?').get(fixtureId);
  if (!fixture) throw new Error(`Fixture ${fixtureId} not found`);
  if (fixture.status !== 'pending') {
    throw new Error(`Fixture ${fixtureId} is ${fixture.status}, not pending`);
  }

  const homeLineup = selectLineup(db, fixture.home_team_id);
  const awayLineup = selectLineup(db, fixture.away_team_id);
  if (!homeLineup || !awayLineup) {
    return forfeitFixture(db, fixture, !homeLineup, !awayLineup);
  }

  const stageRow = db.prepare(
    'SELECT id, file_name FROM stage WHERE active = 1 ORDER BY RANDOM() LIMIT 1'
  ).get();
  if (!stageRow) throw new Error('No active stages available');

  db.prepare(
    "UPDATE fixture SET status = 'running', stage_id = ?, started_at = datetime('now') WHERE id = ?"
  ).run(stageRow.id, fixture.id);

  const insertSlot = db.prepare(`
    INSERT INTO fixture_match
      (fixture_id, slot, home_owned_fighter_id, away_owned_fighter_id, stage_id,
       home_rounds, away_rounds, winner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let homeScore = 0, awayScore = 0;
  const slotResults = [];
  for (let i = 0; i < 5; i++) {
    const h = homeLineup[i];
    const a = awayLineup[i];
    const r = await runOwnedFighterMatch({
      db,
      homeOwnedFighterId: h.id,
      awayOwnedFighterId: a.id,
      stageFileName: stageRow.file_name,
    });
    let winner;
    if (r.winner === 'fighter1') { homeScore++; winner = 'home'; }
    else if (r.winner === 'fighter2') { awayScore++; winner = 'away'; }
    else winner = 'draw';

    insertSlot.run(
      fixture.id, i + 1, h.id, a.id, stageRow.id,
      r.fighter1Rounds, r.fighter2Rounds, winner
    );
    slotResults.push({
      slot: i + 1,
      home: { id: h.id, name: h.display_name },
      away: { id: a.id, name: a.display_name },
      winner, homeRounds: r.fighter1Rounds, awayRounds: r.fighter2Rounds,
    });
  }

  const winnerTeamId = homeScore > awayScore ? fixture.home_team_id
    : awayScore > homeScore ? fixture.away_team_id
    : null;

  const finalize = db.transaction(() => {
    db.prepare(`
      UPDATE fixture SET status = 'complete', home_score = ?, away_score = ?,
        winner_team_id = ?, finished_at = datetime('now') WHERE id = ?
    `).run(homeScore, awayScore, winnerTeamId, fixture.id);
    updateStandings(db, fixture.division_id, fixture.home_team_id, fixture.away_team_id, homeScore, awayScore);
    maybeCompleteLeague(db, fixture.division_id);
  });
  finalize();

  return {
    fixture: { ...fixture, home_score: homeScore, away_score: awayScore, winner_team_id: winnerTeamId },
    homeScore, awayScore, winnerTeamId,
    stage: stageRow.file_name,
    slots: slotResults,
  };
}

function forfeitFixture(db, fixture, homeShort, awayShort) {
  let homeScore = 0, awayScore = 0, winnerTeamId = null;
  if (homeShort && awayShort) {
    // nothing — record as 0-0 no-contest
  } else if (homeShort) {
    awayScore = 5; winnerTeamId = fixture.away_team_id;
  } else {
    homeScore = 5; winnerTeamId = fixture.home_team_id;
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE fixture SET status = 'complete', home_score = ?, away_score = ?,
        winner_team_id = ?, started_at = COALESCE(started_at, datetime('now')),
        finished_at = datetime('now') WHERE id = ?
    `).run(homeScore, awayScore, winnerTeamId, fixture.id);
    if (!(homeShort && awayShort)) {
      updateStandings(db, fixture.division_id, fixture.home_team_id, fixture.away_team_id, homeScore, awayScore);
    }
    maybeCompleteLeague(db, fixture.division_id);
  });
  tx();

  return { fixture, homeScore, awayScore, winnerTeamId, forfeit: true, slots: [] };
}

function updateStandings(db, divisionId, homeId, awayId, homeScore, awayScore) {
  const homeWon = homeScore > awayScore;
  const awayWon = awayScore > homeScore;
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
  const withStandings = divisions.map((d) => ({
    ...d,
    standings: db.prepare(`
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
    `).all(d.id),
  }));
  const pending = db.prepare(`
    SELECT COUNT(*) AS n FROM fixture f
    JOIN division d ON f.division_id = d.id
    WHERE d.league_id = ? AND f.status != 'complete'
  `).get(leagueId).n;
  return { league, divisions: withStandings, pending };
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
