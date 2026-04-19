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

function getBotTeamIds(db) {
  return db.prepare(`
    SELECT t.id FROM team t JOIN user_account u ON t.user_id = u.id
    WHERE u.is_bot = 1 ORDER BY u.id
  `).all().map((r) => r.id);
}
