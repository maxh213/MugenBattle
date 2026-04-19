/**
 * End-to-end-ish tests for the league/season pipeline. Runs in fake-match
 * mode (MB_MATCH_MODE=fake) so no Ikemen is spawned — each test completes
 * in milliseconds. MB_DB_PATH=:memory: gives a fresh in-memory DB per
 * `npm test` invocation.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, getDb } from '../src/db.js';
import { seedBots } from '../src/bots.js';
import {
  createSeason,
  getStandings,
  computeNextSeasonSeating,
  listLeagues,
  autoCreateSeason,
} from '../src/leagues.js';
import { runLeagueWorker } from '../src/leagueWorker.js';

function reopen() {
  closeDb();
  return getDb();
}

function seedBaseWorld(db) {
  // KFM: non-unique training dummy.
  db.prepare(
    "INSERT INTO fighter (file_name, display_name, is_master, is_unique, active) VALUES ('kfm', 'Kung Fu Man', 1, 0, 1)"
  ).run();
  // 40 unique 0-win masters — enough for 8 bots × 4 unique each (32) + headroom.
  const insertM = db.prepare(
    "INSERT INTO fighter (file_name, display_name, is_master, is_unique, active, matches_won) VALUES (?, ?, 1, 1, 1, 0)"
  );
  for (let i = 1; i <= 40; i++) {
    insertM.run(`m_${i.toString().padStart(3, '0')}`, `Master ${i}`);
  }
  // One active stage (selectLineup + runFixture need one).
  db.prepare("INSERT INTO stage (file_name, display_name, active) VALUES ('teststage', 'Test Stage', 1)").run();
}

before(() => {
  assert.equal(process.env.MB_MATCH_MODE, 'fake', 'tests must run with MB_MATCH_MODE=fake');
});

beforeEach(() => {
  // Fresh in-memory DB per test so state doesn't leak.
  reopen();
  const db = getDb();
  seedBaseWorld(db);
});

test('2×2 season runs through to complete with valid standings', async () => {
  const db = getDb();
  // 4 bot teams fill a 2-div × 2-per season.
  seedBots(db, 4);

  const leagueId = createSeason(db, {
    name: 'T1',
    divisions: [
      { name: 'Division 1', teamIds: getBotTeamIds(db).slice(0, 2) },
      { name: 'Division 2', teamIds: getBotTeamIds(db).slice(2, 4) },
    ],
  });

  const r = await runLeagueWorker(db, leagueId);
  assert.equal(r.stopped, false, 'worker shouldn\'t be stopped');
  // 2 divs × 1 fixture each = 2.
  assert.equal(r.fixturesRun, 2);

  const league = db.prepare('SELECT status FROM league WHERE id = ?').get(leagueId);
  assert.equal(league.status, 'complete', 'league should auto-complete');

  const data = getStandings(db, leagueId);
  assert.equal(data.divisions.length, 2);
  for (const d of data.divisions) {
    assert.equal(d.standings.length, 2);
    // Every team plays exactly 1 fixture in a 2-team round robin.
    for (const s of d.standings) assert.equal(s.fixtures_played, 1);
    // Points sanity: either 3+0 (one winner) or 1+1 (draw).
    const pts = d.standings.map((s) => s.points).sort();
    const valid = (pts[0] === 0 && pts[1] === 3) || (pts[0] === 1 && pts[1] === 1);
    assert.ok(valid, `bogus points distribution: ${JSON.stringify(pts)}`);
  }
});

test('promotion/relegation: top of lower tier moves up, bottom of upper tier moves down', async () => {
  const db = getDb();
  seedBots(db, 4);

  // Season 1: 2×2
  const botIds = getBotTeamIds(db);
  const s1 = createSeason(db, {
    name: 'S1',
    divisions: [
      { name: 'Division 1', teamIds: [botIds[0], botIds[1]] },
      { name: 'Division 2', teamIds: [botIds[2], botIds[3]] },
    ],
  });
  await runLeagueWorker(db, s1);
  assert.equal(db.prepare('SELECT status FROM league WHERE id = ?').get(s1).status, 'complete');

  // Grab the winner of each tier from s1.
  const s1Data = getStandings(db, s1);
  const tier1Winner = s1Data.divisions[0].standings[0].team_id;
  const tier1Loser = s1Data.divisions[0].standings[1].team_id;
  const tier2Winner = s1Data.divisions[1].standings[0].team_id;
  const tier2Loser = s1Data.divisions[1].standings[1].team_id;

  const seating = computeNextSeasonSeating(db, {
    divCount: 2, perDiv: 2, promotePerTier: 1,
  });
  assert.ok(seating, 'seating should return a plan');

  // Tier 1 new occupants: the tier-1 winner + the tier-2 winner.
  const newTier1 = new Set(seating.divisions[0].teamIds);
  assert.ok(newTier1.has(tier1Winner), 'tier-1 winner should stay tier 1');
  assert.ok(newTier1.has(tier2Winner), 'tier-2 winner should promote to tier 1');

  // New tier 2 should have the tier-1 loser (relegated).
  const newTier2 = new Set(seating.divisions[1].teamIds);
  assert.ok(newTier2.has(tier1Loser), 'tier-1 loser should relegate to tier 2');

  // The tier-2 loser drops from the bracket entirely (bottom of bottom).
  assert.deepEqual(seating.dropped, [tier2Loser]);
  assert.ok(!newTier1.has(tier2Loser));
  assert.ok(!newTier2.has(tier2Loser));
});

test('bots accumulate prize money from fixture wins', async () => {
  const db = getDb();
  seedBots(db, 4);

  const botIds = getBotTeamIds(db);
  const leagueId = createSeason(db, {
    name: 'Prize check',
    divisions: [
      { name: 'Division 1', teamIds: [botIds[0], botIds[1]] },
      { name: 'Division 2', teamIds: [botIds[2], botIds[3]] },
    ],
  });
  await runLeagueWorker(db, leagueId);

  const total = db.prepare(`
    SELECT SUM(balance_cents) AS s FROM user_account WHERE is_bot = 1
  `).get().s;
  // 2 fixtures. Each fixture pays either 50 (W) or 50 (draw = 25×2). So total = 100.
  assert.equal(total, 100);
});

test('listLeagues exposes progress counters', async () => {
  const db = getDb();
  seedBots(db, 4);
  const botIds = getBotTeamIds(db);
  const leagueId = createSeason(db, {
    name: 'Progress',
    divisions: [
      { name: 'Division 1', teamIds: [botIds[0], botIds[1]] },
      { name: 'Division 2', teamIds: [botIds[2], botIds[3]] },
    ],
  });
  const beforeRun = listLeagues(db).find((l) => l.id === leagueId);
  assert.equal(beforeRun.fixture_count, 2);
  assert.equal(beforeRun.fixtures_done, 0);

  await runLeagueWorker(db, leagueId);

  const afterRun = listLeagues(db).find((l) => l.id === leagueId);
  assert.equal(afterRun.fixtures_done, 2);
  assert.equal(afterRun.status, 'complete');
});

test('head-to-head breaks ties on pts+diff+wins', async () => {
  const db = getDb();
  // Hand-roll a league we can control the outcomes of. 3 teams in 1 div,
  // each plays each once. We stuff fixture_match counts by fiat.
  const leagueId = db.prepare(
    "INSERT INTO league (name, status, started_at) VALUES ('H2H', 'running', datetime('now'))"
  ).run().lastInsertRowid;
  const divId = db.prepare(
    "INSERT INTO division (league_id, tier, name) VALUES (?, 1, 'Division 1')"
  ).run(leagueId).lastInsertRowid;

  // Three teams: A, B, C. We rig the standings so A and B both have
  // pts=3, matches 1W-1L (diff=0, wins=1), and C is third. H2H between
  // A and B has A winning → A should sort above B.
  function mkBot(n) {
    const uid = db.prepare("INSERT INTO user_account (email, username, is_bot) VALUES (?, ?, 1)").run(`t${n}@x`, `t${n}`).lastInsertRowid;
    const tid = db.prepare('INSERT INTO team (user_id, name) VALUES (?, ?)').run(uid, `Team ${n}`).lastInsertRowid;
    db.prepare('INSERT INTO division_team (division_id, team_id) VALUES (?, ?)').run(divId, tid);
    return tid;
  }
  const A = mkBot('A');
  const B = mkBot('B');
  const C = mkBot('C');

  function applyFixture(home, away, hWins, aWins) {
    const wt = hWins > aWins ? home : aWins > hWins ? away : null;
    db.prepare(
      "INSERT INTO fixture (division_id, round_num, slot_num, home_team_id, away_team_id, status, home_score, away_score, winner_team_id) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?)"
    ).run(divId, 1, 1, home, away, hWins, aWins, wt);
    const pts = (t, h, a) => (h > a ? 3 : a > h ? 0 : 1);
    db.prepare(
      "UPDATE division_team SET points = points + ?, fixtures_played = fixtures_played + 1, fixtures_won = fixtures_won + ?, fixtures_lost = fixtures_lost + ?, fixtures_drawn = fixtures_drawn + ?, matches_won = matches_won + ?, matches_lost = matches_lost + ? WHERE division_id = ? AND team_id = ?"
    ).run(pts(home, hWins, aWins), hWins > aWins ? 1 : 0, aWins > hWins ? 1 : 0, hWins === aWins ? 1 : 0, hWins, aWins, divId, home);
    db.prepare(
      "UPDATE division_team SET points = points + ?, fixtures_played = fixtures_played + 1, fixtures_won = fixtures_won + ?, fixtures_lost = fixtures_lost + ?, fixtures_drawn = fixtures_drawn + ?, matches_won = matches_won + ?, matches_lost = matches_lost + ? WHERE division_id = ? AND team_id = ?"
    ).run(pts(away, aWins, hWins), aWins > hWins ? 1 : 0, hWins > aWins ? 1 : 0, hWins === aWins ? 1 : 0, aWins, hWins, divId, away);
  }
  // A 3-2 B (A wins this head-to-head)
  applyFixture(A, B, 3, 2);
  // A 0-5 C, B 5-0 C  → A beat B, B beat C, C lost to both
  applyFixture(A, C, 0, 5);
  applyFixture(B, C, 5, 0);
  // After:
  //   A: pts=3 (1W 1L), matches 3+0=3 won, 2+5=7 lost, diff=-4
  //   B: pts=3 (1W 1L), matches 2+5=7 won, 3+0=3 lost, diff=+4
  //   C: pts=3 (1W 1L), matches 5+0=5 won, 0+5=5 lost, diff=0
  // Tie on pts only; diff splits them cleanly (B > C > A).
  //
  // That's fine for the test — what we want to verify is that if pts+diff+wins
  // ALL match, H2H kicks in. So let's add another fixture to neutralise the diff.

  // Make all 3 have identical pts, diff, and wins: we'll tweak so that each
  // has pts=3, wins=5, losses=5 (diff=0). Adjust B and A.
  db.prepare(
    "UPDATE division_team SET matches_won = 5, matches_lost = 5 WHERE division_id = ? AND team_id = ?"
  ).run(divId, A);
  db.prepare(
    "UPDATE division_team SET matches_won = 5, matches_lost = 5 WHERE division_id = ? AND team_id = ?"
  ).run(divId, B);
  db.prepare(
    "UPDATE division_team SET matches_won = 5, matches_lost = 5 WHERE division_id = ? AND team_id = ?"
  ).run(divId, C);

  const data = getStandings(db, leagueId);
  const ranks = data.divisions[0].standings.map((s) => s.team_id);

  // All tied on pts+diff+wins → H2H mini-league decides. From the fixtures:
  //   A vs B → A scored 3, B scored 2 → A won
  //   A vs C → A scored 0, C scored 5 → C won
  //   B vs C → B scored 5, C scored 0 → B won
  // Mini-table: A 1W 1L (pts 3), B 1W 1L (pts 3), C 1W 1L (pts 3).
  // All tied in mini-pts too, fall through to mini-diff:
  //   A mini-diff: 3-2 + 0-5 = +3 - 5 = -2
  //   B mini-diff: 2-3 + 5-0 = -1 + 5 = +4
  //   C mini-diff: 5-0 + 0-5 = +5 - 5 = 0
  // So B > C > A.
  assert.deepEqual(ranks, [B, C, A]);
});

test('autoCreateSeason runs twice back-to-back (continuous mode)', async () => {
  const db = getDb();
  // Season 1: seeds bots from scratch, hadPrevSeason=false.
  const s1 = autoCreateSeason(db, { divCount: 2, perDiv: 2, promotePerTier: 1 });
  assert.ok(s1, 'first autoCreateSeason should succeed');
  assert.equal(s1.hadPrevSeason, false);
  assert.equal(s1.totalSlots, 4);

  await runLeagueWorker(db, s1.leagueId);
  assert.equal(db.prepare('SELECT status FROM league WHERE id = ?').get(s1.leagueId).status, 'complete');

  // Season 2: prev now exists — should seed from its standings and pick up
  // where we left off without any manual intervention.
  const s2 = autoCreateSeason(db, { divCount: 2, perDiv: 2, promotePerTier: 1 });
  assert.ok(s2, 'second autoCreateSeason should succeed');
  assert.equal(s2.hadPrevSeason, true);
  assert.ok(s2.dropped.length >= 1, 'at least one team should drop from bottom-of-bottom');

  await runLeagueWorker(db, s2.leagueId);
  assert.equal(db.prepare('SELECT status FROM league WHERE id = ?').get(s2.leagueId).status, 'complete');
});

function getBotTeamIds(db) {
  return db.prepare(`
    SELECT t.id FROM team t JOIN user_account u ON t.user_id = u.id
    WHERE u.is_bot = 1 ORDER BY u.id
  `).all().map((r) => r.id);
}
