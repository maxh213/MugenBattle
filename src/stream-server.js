#!/usr/bin/env node
/**
 * Live match streaming server.
 *
 * - Spawns STREAM_WORKERS parallel stream workers. Each worker owns an
 *   Xvfb (on display :100, :101, ...), an ffmpeg capturing it as MJPEG,
 *   and an optional runLeagueWorker loop driving a league's fixtures.
 * - /stream[/<id>]          MJPEG feed for that worker (bare /stream = #1).
 * - /api/workers            JSON status list.
 * - /                       Dashboard; existing auth/team/fighter/leaderboard routes
 *                           are unchanged.
 * - A supervisor assigns running leagues to idle workers on a 10s poll.
 *
 * Env knobs:
 *   STREAM_PORT             HTTP port (default 8080)
 *   STREAM_WORKERS          parallel worker count (default 1)
 *   STREAM_DISPLAY_BASE     base for worker X displays (default 99 → :100+i)
 *   STREAM_SIZE             capture resolution (default 640x480)
 *   STREAM_FPS              capture framerate (default 15)
 *   STREAM_AUTO_SEASONS=1   continuous mode: auto-create next season when
 *                           no league is running. Off by default.
 *   STREAM_AUTO_DIVS        tiers per season (default 3)
 *   STREAM_AUTO_PER_DIV     teams per division (default 20, PL-sized)
 *   STREAM_AUTO_LEGS        round-robin legs (default 2 = home+away)
 *   STREAM_AUTO_PROMOTE_PER_TIER  top/bottom N per tier (default 3)
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync, createReadStream } from 'fs';
import { createServer } from 'http';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import {
  sendCode,
  verifyCode,
  setUsername,
  currentUser,
  sessionCookieHeader,
} from './auth.js';
import { getTeamForUser, getTeamById, setLineup, topUpRoster, listOpenNotices, dismissNotice } from './teams.js';
import { tickBotMarket } from './botMarket.js';
import {
  listExhibitionFighters,
  enqueueExhibition,
  getExhibition,
  claimNextPendingExhibition,
  listExhibitionsForUser,
  resetStuckExhibitions,
  createExhibitionTournament,
  getExhibitionTournament,
  getActiveTournamentForUser,
  cancelExhibitionTournament,
  claimNextPendingTournamentMatch,
  resetStuckTournamentMatches,
  listLiveTournaments,
  listRecentTournaments,
  listTournamentWinsForMaster,
} from './exhibition.js';
import { getEffectiveCmd, saveCmdOverride } from './matchStaging.js';
import { StreamWorker } from './streamWorker.js';
import {
  getLiveLeagueContext,
  getStandings,
  latestInterestingLeagueId,
  ownedFighterHistory,
  teamSchedule,
  autoCreateSeason,
  replaceInactiveMasterClones,
  getLiveTierView,
} from './leagues.js';
import {
  marketListings,
  buyUnclaimedMaster,
  suggestedPriceForOwned,
  listForSale,
  unlistFromSale,
  buyListedFighter,
  userListings,
  marketStageListings,
  userStageListings,
  getHomeStage,
  buyUnclaimedStage,
  listStageForSale,
  unlistStage,
  buyListedStage,
  priceForStage,
  releaseOwnedFighter,
  releaseStage,
} from './market.js';
import { importCharFromZip, listUserImports } from './charImport.js';
import { follow, unfollow, listFollows } from './follow.js';
import { writeFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CHARS_DIR = join(ROOT, 'engine', 'chars');
const STATE_FILE = '/tmp/mugenbattle-match-state.json';

const PORT = parseInt(process.env.STREAM_PORT || '8080', 10);
// Default to Ikemen's native 640x480 so the captured image is 1:1 (no padding).
// Can override with STREAM_SIZE env if you reconfigure engine/save/config.json.
const SIZE = process.env.STREAM_SIZE || '640x480';
const FPS = parseInt(process.env.STREAM_FPS || '15', 10);
// How many parallel league streams to run. Each gets its own Xvfb, ffmpeg,
// and Ikemen process so they don't stomp each other.
const WORKER_COUNT = Math.max(1, parseInt(process.env.STREAM_WORKERS || '1', 10));
const DISPLAY_BASE = parseInt(process.env.STREAM_DISPLAY_BASE || '99', 10);
// Dedicated exhibition workers run user-requested ad-hoc matches off the
// /exhibition page. They never run league fixtures so the league pool keeps
// chugging undisturbed. Each gets its own Xvfb/ffmpeg.
const EXHIBITION_WORKER_COUNT = Math.max(0, parseInt(process.env.EXHIBITION_WORKERS || '1', 10));
const SUPERVISOR_POLL_MS = 10_000;
// Faster cadence for exhibition supervisor — feels snappier when you click
// "Spar" and a worker is sitting idle waiting.
const EXHIBITION_SUPERVISOR_POLL_MS = 1500;
// Hard cap on simultaneously-running tournaments. Beyond this the rest sit
// 'pending' until a slot frees up. Defaults to the worker count so each
// running tournament gets at least one worker on average — set higher to
// allow more concurrent tournaments at the cost of slower per-tournament
// pacing, or lower to keep brackets snappy.
const MAX_CONCURRENT_TOURNAMENTS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_TOURNAMENTS || String(Math.max(EXHIBITION_WORKER_COUNT, 1)), 10));
// Bot transfer-market tick: each tick a small fraction of bot teams scout
// the market and may sell/buy. Default 5min so activity is visible but
// not chaotic. Set BOT_MARKET_DISABLED=1 to turn it off entirely.
const BOT_MARKET_TICK_MS = parseInt(process.env.BOT_MARKET_TICK_MS || '300000', 10);
const BOT_MARKET_DISABLED = process.env.BOT_MARKET_DISABLED === '1';
// Continuous-seasons mode: when no league is running, auto-create the next
// one so the stream never idles. Off by default so `node src/stream-server`
// on a dev laptop doesn't silently burn cycles.
const AUTO_SEASONS = process.env.STREAM_AUTO_SEASONS === '1';
// Premier-League-style defaults: 20 teams per tier, home + away (38 fixtures
// per team), 3 up / 3 down between tiers. Points are already 3 / 1 / 0.
const AUTO_DIVS = parseInt(process.env.STREAM_AUTO_DIVS || '3', 10);
const AUTO_PER_DIV = parseInt(process.env.STREAM_AUTO_PER_DIV || '20', 10);
const AUTO_LEGS = parseInt(process.env.STREAM_AUTO_LEGS || '2', 10);
const AUTO_PROMOTE_PER_TIER = parseInt(process.env.STREAM_AUTO_PROMOTE_PER_TIER || '3', 10);

// ---------- Worker pool ----------

/** workerId → StreamWorker. workerId is 1-indexed for URL friendliness. */
const workers = new Map();
const audioClients = new Set();
const PULSE_SOURCE = process.env.STREAM_AUDIO_SOURCE || 'mugenbattle.monitor';
let audioFfmpeg;

/**
 * Stash a pristine copy of engine/save/config.json on first valid boot.
 * runMatch.sh uses it to seed per-worker private save dirs. We no longer
 * self-heal the host file — it's only read as a seed and never written by
 * match processes (bwrap bind-mounts a per-match scratch copy over it).
 */
function seedPristineConfig() {
  const cfg = resolve(ROOT, 'engine', 'save', 'config.json');
  const pristine = cfg + '.pristine';
  if (!existsSync(cfg) || existsSync(pristine)) return;
  try {
    JSON.parse(readFileSync(cfg, 'utf-8'));
    writeFileSync(pristine, readFileSync(cfg));
    console.log('[boot] saved engine/save/config.json.pristine');
  } catch {}
}

async function bootWorkers() {
  // Crash recovery: any fixture left in 'running' from a previous boot gets
  // pushed back to 'pending' so a worker picks it up fresh. We also delete
  // any partial fixture_match rows so the re-run doesn't hit a UNIQUE
  // (fixture_id, slot) collision. Losing mid-match progress is cheap —
  // 5 matches × ~10s.
  const db = getDb();
  const reset = db.transaction(() => {
    const stuck = db.prepare("SELECT id FROM fixture WHERE status = 'running'").all();
    if (stuck.length === 0) return 0;
    const delMatch = db.prepare('DELETE FROM fixture_match WHERE fixture_id = ?');
    const setPending = db.prepare("UPDATE fixture SET status = 'pending', started_at = NULL WHERE id = ?");
    for (const f of stuck) {
      delMatch.run(f.id);
      setPending.run(f.id);
    }
    return stuck.length;
  })();
  if (reset > 0) console.log(`[boot] reset ${reset} stuck 'running' fixture(s) to 'pending'`);

  seedPristineConfig();

  // Retire clones of any already-inactive master AND replace them with KFM
  // training dummies in the same slot, so teams keep a full 5-active lineup
  // instead of forfeiting every subsequent fixture. The user can release
  // the KFM and buy a real replacement on /team.
  const swapped = replaceInactiveMasterClones(db);
  if (swapped > 0) {
    console.log(`[boot] swapped ${swapped} clone(s) of deactivated masters with KFM`);
  }

  // Boot-time roster sweep: any team in a running league with fewer than 5
  // active non-retired fighters gets topped up from the oldest unclaimed
  // pool. Without this, a team could sit empty for many fixtures before its
  // own slot in the worker queue came up — long enough that the user sees
  // the empty roster on /team and assumes it's broken.
  const shortTeams = db.prepare(`
    SELECT t.id, t.name FROM team t
    JOIN division_team dt ON dt.team_id = t.id
    JOIN division d ON d.id = dt.division_id
    JOIN league l ON l.id = d.league_id
    WHERE l.status = 'running'
      AND (SELECT COUNT(*) FROM owned_fighter
           WHERE team_id = t.id AND is_retired = 0 AND slot = 'active') < 5
  `).all();
  for (const t of shortTeams) {
    const r = topUpRoster(db, t.id);
    if (r.added > 0) console.log(`[boot] auto-replenished ${r.added} fighter(s) for team #${t.id} (${t.name})`);
  }

  for (let i = 1; i <= WORKER_COUNT; i++) {
    const w = new StreamWorker({
      workerId: i,
      kind: 'league',
      display: `:${DISPLAY_BASE + i}`,
      size: SIZE,
      fps: FPS,
      logPath: `/tmp/mb-worker-${i}.log`,
    });
    workers.set(i, w);
    try {
      await w.start();
    } catch (err) {
      console.error(`[boot] worker ${i} failed to start: ${err.message}`);
    }
  }

  // Exhibition workers live on displays past the league worker range so
  // their X11 sockets and worker IDs never collide. workerId 100+ is
  // reserved for exhibitions (we'd never spin up 100+ league workers).
  const stuckEx = resetStuckExhibitions(db);
  if (stuckEx > 0) console.log(`[boot] reset ${stuckEx} stuck 'running' exhibition(s) to 'failed'`);
  const stuckTm = resetStuckTournamentMatches(db);
  if (stuckTm > 0) console.log(`[boot] reset ${stuckTm} stuck 'running' tournament match(es) to 'pending'`);
  for (let i = 1; i <= EXHIBITION_WORKER_COUNT; i++) {
    const id = 100 + i;
    const w = new StreamWorker({
      workerId: id,
      kind: 'exhibition',
      display: `:${DISPLAY_BASE + WORKER_COUNT + i}`,
      size: SIZE,
      fps: FPS,
      logPath: `/tmp/mb-exhibition-${i}.log`,
    });
    workers.set(id, w);
    try {
      await w.start();
    } catch (err) {
      console.error(`[boot] exhibition worker ${id} failed to start: ${err.message}`);
    }
  }
}

/**
 * Every SUPERVISOR_POLL_MS: for each idle worker, find a running league that
 * isn't already claimed by another worker and assign it. Tidy way to keep the
 * pool busy without manual assignment.
 */
function startSupervisor() {
  setInterval(() => {
    const db = getDb();
    const leagueWorkers = Array.from(workers.values()).filter((w) => w.kind === 'league');
    // Track claimed divisions — each worker runs one division of one league.
    const claimedDivs = new Set(
      leagueWorkers.map((w) => w.divisionId).filter((x) => x != null)
    );
    let leagues = db.prepare(`
      SELECT id FROM league WHERE status = 'running' ORDER BY id
    `).all();

    // Continuous-seasons mode: if nothing is running right now, seed the
    // next season so the workers never sit idle. maybeCompleteLeague
    // finalises the previous one on the last fixture, so by the time we
    // hit this branch bot rosters have already retired and teams are
    // eligible for a fresh seating.
    if (AUTO_SEASONS && leagues.length === 0) {
      try {
        const r = autoCreateSeason(db, {
          divCount: AUTO_DIVS, perDiv: AUTO_PER_DIV,
          legs: AUTO_LEGS, promotePerTier: AUTO_PROMOTE_PER_TIER,
        });
        if (r) {
          console.log(`[supervisor] auto-created league ${r.leagueId} "${r.name}" (${AUTO_DIVS}×${AUTO_PER_DIV}, bots=${r.botsUsed})`);
          leagues = [{ id: r.leagueId }];
        }
      } catch (err) {
        console.error(`[supervisor] auto-season failed: ${err.message}`);
      }
    }

    // Build candidate (leagueId, divisionId) assignments: every division of
    // every running league that still has a pending fixture and isn't
    // already claimed by a worker.
    const candidates = [];
    for (const l of leagues) {
      const divs = db.prepare(`
        SELECT d.id AS division_id
        FROM division d
        WHERE d.league_id = ?
          AND EXISTS (SELECT 1 FROM fixture f WHERE f.division_id = d.id AND f.status = 'pending')
        ORDER BY d.tier
      `).all(l.id);
      for (const d of divs) {
        if (!claimedDivs.has(d.division_id)) candidates.push({ leagueId: l.id, divisionId: d.division_id });
      }
    }

    for (const w of leagueWorkers) {
      if (w.status !== 'idle') continue;
      const next = candidates.shift();
      if (!next) break;
      console.log(`[supervisor] league ${next.leagueId} div ${next.divisionId} → worker ${w.workerId}`);
      w.assignLeague(db, next.leagueId, next.divisionId);
    }
  }, SUPERVISOR_POLL_MS);
}

/**
 * Bot market supervisor: every BOT_MARKET_TICK_MS, a small random subset of
 * bot teams scouts the market and may buy/sell. Reuses the same buy/sell
 * functions humans use, so listings, prices, and balances stay coherent.
 */
function startBotMarketSupervisor() {
  if (BOT_MARKET_DISABLED) {
    console.log('[bot-market] disabled via BOT_MARKET_DISABLED=1');
    return;
  }
  const tick = () => {
    try {
      const stats = tickBotMarket(getDb());
      if (stats.sold || stats.bought) {
        console.log(`[bot-market] ${stats.considered}/${stats.bots} acted · ${stats.sold} listed · ${stats.bought} bought`);
        for (const line of stats.log) console.log(`[bot-market] ${line}`);
      }
    } catch (err) {
      console.error(`[bot-market] tick failed: ${err.message}`);
    }
  };
  setInterval(tick, BOT_MARKET_TICK_MS);
  // Don't run immediately on boot — let the league supervisor get its claim
  // pass in first so the first tick happens after the simulation is warm.
  setTimeout(tick, BOT_MARKET_TICK_MS);
  console.log(`[bot-market] tick every ${Math.round(BOT_MARKET_TICK_MS / 1000)}s`);
}

/**
 * Exhibition supervisor: dedicated workers (kind='exhibition') only. Polls
 * frequently because exhibitions are user-triggered — feels broken if a
 * sparring request sits 10s before claiming a worker.
 */
function startExhibitionSupervisor() {
  if (EXHIBITION_WORKER_COUNT === 0) return;
  setInterval(() => {
    const db = getDb();
    const exWorkers = Array.from(workers.values()).filter((w) => w.kind === 'exhibition');
    // Single matches first so individual user spars feel snappier than a
    // 32-fighter bracket sucking up the whole pool.
    for (const w of exWorkers) {
      if (w.status !== 'idle') continue;
      const claimed = claimNextPendingExhibition(db, w.workerId);
      if (!claimed) break;
      console.log(`[ex-supervisor] exhibition ${claimed.id} → worker ${w.workerId}`);
      w.assignExhibition(db, claimed.id);
    }
    // Then tournaments — multiple matches in the same round can run
    // concurrently across workers because they're independent.
    for (const w of exWorkers) {
      if (w.status !== 'idle') continue;
      const claimed = claimNextPendingTournamentMatch(db, w.workerId, MAX_CONCURRENT_TOURNAMENTS);
      if (!claimed) break;
      console.log(`[ex-supervisor] tournament match ${claimed.id} (t#${claimed.tournament_id}) → worker ${w.workerId}`);
      w.assignTournamentMatch(db, claimed.id);
    }
  }, EXHIBITION_SUPERVISOR_POLL_MS);
}

function startAudio() {
  // Capture the mugenbattle PulseAudio sink monitor, encode to MP3, and
  // broadcast to any connected /audiostream clients as chunked HTTP.
  audioFfmpeg = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'pulse',
    '-i', PULSE_SOURCE,
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '44100',
    '-f', 'mp3',
    '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  audioFfmpeg.stdout.on('data', (chunk) => {
    for (const c of audioClients) {
      try { c.write(chunk); } catch {}
    }
  });
  audioFfmpeg.stderr.on('data', (d) => process.stderr.write(`[audio] ${d}`));
  audioFfmpeg.on('exit', (code) => {
    console.error(`[audio] ffmpeg exited with code ${code}`);
    audioFfmpeg = null;
  });
  console.log(`[audio] capturing ${PULSE_SOURCE} → mp3 @ 128k`);
}

// ---------- State + DB queries ----------

function readMatchState() {
  try {
    if (!existsSync(STATE_FILE)) return null;
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch { return null; }
}

function getLeaderboard(limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT file_name, display_name, author, matches_won, matches_lost, matches_drawn,
      (matches_won + matches_lost + matches_drawn) AS total_matches,
      CASE WHEN (matches_won + matches_lost + matches_drawn) > 0
        THEN ROUND(100.0 * matches_won / (matches_won + matches_lost + matches_drawn), 1)
        ELSE 0 END AS win_rate
    FROM fighter WHERE active = 1
    ORDER BY matches_won DESC, win_rate DESC
    LIMIT ?
  `).all(limit);
}

function getActiveTournament() {
  const db = getDb();
  const t = db.prepare('SELECT * FROM tournament WHERE status = \'running\' ORDER BY id DESC LIMIT 1').get();
  if (!t) return null;
  const matches = db.prepare(`
    SELECT tm.round, tm.match_index, tm.victor_id,
      tm.fighter_one_id, tm.fighter_two_id,
      f1.file_name AS f1_name, f1.display_name AS f1_display,
      f2.file_name AS f2_name, f2.display_name AS f2_display,
      v.file_name AS v_name, v.display_name AS v_display
    FROM tournament_match tm
    LEFT JOIN fighter f1 ON tm.fighter_one_id = f1.id
    LEFT JOIN fighter f2 ON tm.fighter_two_id = f2.id
    LEFT JOIN fighter v ON tm.victor_id = v.id
    WHERE tm.tournament_id = ?
    ORDER BY tm.round, tm.match_index
  `).all(t.id);
  return { ...t, matches };
}

function getRecentHistory(limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT
      f1.file_name AS f1_fn, f1.display_name AS f1,
      f2.file_name AS f2_fn, f2.display_name AS f2,
      s.display_name AS stage,
      v.file_name AS victor_fn, v.display_name AS victor, fh.fought_at
    FROM fight_history fh
    JOIN fighter f1 ON fh.fighter_one_id = f1.id
    JOIN fighter f2 ON fh.fighter_two_id = f2.id
    JOIN stage s ON fh.stage_id = s.id
    LEFT JOIN fighter v ON fh.victor_id = v.id
    ORDER BY fh.fought_at DESC
    LIMIT ?
  `).all(limit);
}

function getFullLeaderboard() {
  const db = getDb();
  return db.prepare(`
    SELECT file_name, display_name, author, source_url,
      matches_won, matches_lost, matches_drawn,
      (matches_won + matches_lost + matches_drawn) AS total_matches,
      CASE WHEN (matches_won + matches_lost + matches_drawn) > 0
        THEN ROUND(100.0 * matches_won / (matches_won + matches_lost + matches_drawn), 1)
        ELSE 0 END AS win_rate
    FROM fighter WHERE active = 1
    ORDER BY matches_won DESC, win_rate DESC, file_name ASC
  `).all();
}

function getFighterProfile(fileName) {
  const db = getDb();
  const fighter = db.prepare('SELECT * FROM fighter WHERE file_name = ?').get(fileName);
  if (!fighter) return null;
  // Pull from both the legacy `fight_history` (random/tournament matches) and
  // the live `fixture_match` (league matches). Merge in JS, sort by date,
  // take the top 15. Without the second branch, league-only fighters showed
  // no recent fights because everything they did landed in fixture_match.
  const fromHistory = db.prepare(`
    SELECT f1.display_name AS f1, f1.file_name AS f1_file,
      f2.display_name AS f2, f2.file_name AS f2_file,
      s.display_name AS stage,
      v.file_name AS victor_file, v.display_name AS victor, fh.fought_at
    FROM fight_history fh
    JOIN fighter f1 ON fh.fighter_one_id = f1.id
    JOIN fighter f2 ON fh.fighter_two_id = f2.id
    JOIN stage s ON fh.stage_id = s.id
    LEFT JOIN fighter v ON fh.victor_id = v.id
    WHERE fh.fighter_one_id = ? OR fh.fighter_two_id = ?
    ORDER BY fh.fought_at DESC LIMIT 15
  `).all(fighter.id, fighter.id);
  // fixture_match rows are pre-inserted with winner='draw' the moment a
  // fixture goes 'running' (so the live overlay can show who's on screen).
  // The row is UPDATEd with the real winner only at completion. We MUST
  // filter to status='complete' or every active match shows up as a 'D'
  // in the recent-fights table.
  const fromFixtures = db.prepare(`
    SELECT mf1.display_name AS f1, mf1.file_name AS f1_file,
      mf2.display_name AS f2, mf2.file_name AS f2_file,
      s.display_name AS stage,
      CASE
        WHEN fm.winner = 'home' THEN mf1.file_name
        WHEN fm.winner = 'away' THEN mf2.file_name
        ELSE NULL
      END AS victor_file,
      CASE
        WHEN fm.winner = 'home' THEN mf1.display_name
        WHEN fm.winner = 'away' THEN mf2.display_name
        ELSE NULL
      END AS victor,
      fm.played_at AS fought_at
    FROM fixture_match fm
    JOIN fixture fx ON fx.id = fm.fixture_id
    JOIN owned_fighter oh ON oh.id = fm.home_owned_fighter_id
    JOIN owned_fighter oa ON oa.id = fm.away_owned_fighter_id
    JOIN fighter mf1 ON mf1.id = oh.master_fighter_id
    JOIN fighter mf2 ON mf2.id = oa.master_fighter_id
    JOIN stage s ON s.id = fm.stage_id
    WHERE (oh.master_fighter_id = ? OR oa.master_fighter_id = ?)
      AND fx.status = 'complete'
    ORDER BY fm.played_at DESC LIMIT 15
  `).all(fighter.id, fighter.id);
  const recent = [...fromHistory, ...fromFixtures]
    .sort((a, b) => (b.fought_at || '').localeCompare(a.fought_at || ''))
    .slice(0, 15);
  // Owner history — every team that's ever held a clone of this master.
  // State per row: 'current' (still owns and clone is active), 'released'
  // (latest entry for this clone AND clone is retired → master returned to
  // pool), 'sold' (a later entry exists for the same clone — newer team
  // bought/inherited it via market or staff reassignment).
  const ownerRows = db.prepare(`
    SELECT t.id AS team_id, t.name AS team_name,
      u.username AS owner_username, u.is_bot AS owner_is_bot,
      h.id AS hist_id, h.owned_fighter_id, h.joined_at, h.reason,
      of.is_retired AS clone_retired,
      of.team_id AS clone_current_team_id
    FROM owned_fighter_team_history h
    JOIN team t ON t.id = h.team_id
    JOIN user_account u ON u.id = t.user_id
    JOIN owned_fighter of ON of.id = h.owned_fighter_id
    WHERE of.master_fighter_id = ?
    ORDER BY h.id DESC
    LIMIT 20
  `).all(fighter.id);
  const latestPerClone = new Map();
  for (const r of ownerRows) {
    const prev = latestPerClone.get(r.owned_fighter_id);
    if (prev == null || r.hist_id > prev) latestPerClone.set(r.owned_fighter_id, r.hist_id);
  }
  const owners = ownerRows.map((r) => {
    const isLatest = r.hist_id === latestPerClone.get(r.owned_fighter_id);
    let state;
    if (!isLatest) state = 'sold';
    else if (r.clone_retired) state = 'released';
    else if (r.clone_current_team_id === r.team_id) state = 'current';
    else state = 'sold';
    return {
      team_id: r.team_id,
      team_name: r.team_name,
      owner_username: r.owner_username,
      owner_is_bot: r.owner_is_bot,
      joined_at: r.joined_at,
      reason: r.reason,
      state,
    };
  });
  const total = fighter.matches_won + fighter.matches_lost + fighter.matches_drawn;
  const tournamentWinsList = listTournamentWinsForMaster(db, fighter.id, 10);
  return {
    ...fighter,
    total_matches: total,
    win_rate: total > 0 ? Math.round(1000 * fighter.matches_won / total) / 10 : 0,
    recent,
    owners,
    tournament_wins_list: tournamentWinsList,
  };
}

// ---------- HTML ----------

const COMMON_CSS = `
  body { background: #0d1117; color: #c9d1d9; font-family: system-ui, sans-serif; margin: 0; padding: 16px; max-width: 1400px; margin-left: auto; margin-right: auto; }
  h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  nav { display: flex; gap: 16px; font-size: 13px; margin-bottom: 16px; }
  nav a { color: #8b949e; }
  nav a.active { color: #c9d1d9; font-weight: 600; }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; }
  .panel h2 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: #8b949e; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: normal; font-size: 11px; cursor: pointer; user-select: none; }
  th:hover { color: #c9d1d9; }
  .clickable { cursor: pointer; }
  .clickable:hover { background: #1d232b; }
  .author { color: #8b949e; font-size: 11px; }
  /* modal */
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
  .modal-bg.open { display: flex; }
  .modal { background: #161b22; border: 1px solid #30363d; border-radius: 10px; max-width: 600px; width: 100%; max-height: 90vh; overflow-y: auto; padding: 18px 22px; }
  .modal h3 { margin: 0 0 4px; font-size: 18px; }
  .modal .sub { color: #8b949e; font-size: 12px; margin-bottom: 12px; }
  .modal .head { display: flex; gap: 14px; align-items: center; margin-bottom: 10px; }
  .modal .portrait { width: 96px; height: 96px; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; image-rendering: pixelated; object-fit: contain; }
  .portrait-thumb { width: 32px; height: 32px; image-rendering: pixelated; object-fit: contain; background: #0d1117; border-radius: 4px; margin-right: 8px; vertical-align: middle; }
  .modal .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
  .modal .stat { background: #0d1117; padding: 10px; border-radius: 6px; text-align: center; }
  .modal .stat .v { font-size: 22px; font-weight: 600; color: #c9d1d9; }
  .modal .stat .l { font-size: 10px; text-transform: uppercase; color: #8b949e; }
  .modal .field { font-size: 12px; margin: 6px 0; }
  .modal .field b { color: #8b949e; display: inline-block; min-width: 80px; }
  .modal .close { position: absolute; top: 12px; right: 16px; cursor: pointer; color: #8b949e; font-size: 22px; }
  .modal-shell { position: relative; }
  /* shared auth bar (top-right signed-in badge + sign-in/out buttons) */
  .auth-bar { position: absolute; top: 16px; right: 16px; font-size: 13px; display: flex; align-items: center; gap: 10px; z-index: 10; }
  .auth-bar button { background: #238636; color: white; border: 1px solid #2ea043; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .auth-bar button:hover { background: #2ea043; }
  .auth-bar .user-email { color: #8b949e; }
  .auth-bar .logout { background: transparent; color: #8b949e; border: 1px solid #30363d; }
  .auth-bar .logout:hover { background: #21262d; color: #c9d1d9; }
  /* auth modal form widgets */
  .auth-form { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
  .auth-form input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; font-size: 14px; }
  .auth-form button { background: #238636; color: white; border: 1px solid #2ea043; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .auth-form .msg { font-size: 12px; min-height: 1em; }
  .auth-form .msg.err { color: #f85149; }
  .auth-form .msg.ok { color: #3fb950; }
`;

const MODAL_HTML = `
<div class="modal-bg" id="modal-bg" onclick="if(event.target===this)closeModal()">
  <div class="modal"><div class="modal-shell">
    <div class="close" onclick="closeModal()">×</div>
    <div id="modal-body"></div>
  </div></div>
</div>
<script>
// Cached follow set + helpers shared across modal-open paths.
let followedMastersCache = null;
async function loadFollowedMasters() {
  if (followedMastersCache) return followedMastersCache;
  try {
    const r = await fetch('/api/follow');
    if (!r.ok) { followedMastersCache = new Set(); return followedMastersCache; }
    const j = await r.json();
    followedMastersCache = new Set(j.masters || []);
  } catch { followedMastersCache = new Set(); }
  return followedMastersCache;
}
async function toggleFollowMaster(masterId, btn) {
  const set = await loadFollowedMasters();
  const isOn = set.has(masterId);
  if (isOn) {
    await fetch('/api/follow/master/' + masterId, { method: 'DELETE' });
    set.delete(masterId);
    btn.classList.remove('on'); btn.textContent = '☆';
    btn.title = 'Follow'; btn.style.color = '#8b949e';
  } else {
    const r = await fetch('/api/follow', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ kind: 'master', id: masterId }) });
    if (r.status === 401) { alert('Sign in to follow fighters.'); return; }
    set.add(masterId);
    btn.classList.add('on'); btn.textContent = '★';
    btn.title = 'Unfollow'; btn.style.color = '#f0ae3c';
  }
}
async function openProfile(fileName) {
  const r = await fetch('/api/fighter/' + encodeURIComponent(fileName));
  if (!r.ok) return;
  const f = await r.json();
  const followed = await loadFollowedMasters();
  const isFollowed = followed.has(f.id);
  const recent = (f.recent || []).map(m => {
    const winLose = m.victor === f.display_name || m.victor_file === f.file_name ? 'W' : (m.victor ? 'L' : 'D');
    const isF1 = (m.f1 === (f.display_name || f.file_name)) || (m.f1_file === f.file_name);
    const opp = isF1 ? m.f2 : m.f1;
    const oppFile = isF1 ? m.f2_file : m.f1_file;
    const oppCell = oppFile
      ? 'vs <span style="cursor:pointer;color:#58a6ff;text-decoration:underline" onclick=\\'openProfile(' + JSON.stringify(oppFile) + ')\\'>' + esc(opp || '?') + '</span>' 
      : 'vs ' + esc(opp || '?');
    return \`<tr><td>\${winLose}</td><td>\${oppCell}</td><td style="color:#8b949e">\${esc(m.stage || '')}</td></tr>\`;
  }).join('');
  const starGlyph = isFollowed ? '★' : '☆';
  const starColor = isFollowed ? '#f0ae3c' : '#8b949e';
  const starTip = isFollowed ? 'Unfollow' : 'Follow';
  const tourneyWinsHtml = (f.tournament_wins_list && f.tournament_wins_list.length) ? \`<h2 style="margin-top:16px;font-size:12px;text-transform:uppercase;color:#8b949e">🏆 Tournament wins</h2><table>\${f.tournament_wins_list.map(t => \`<tr><td style="white-space:nowrap"><a href="/tournaments">#\${t.id}</a></td><td>\${t.size}-fighter bracket · best of \${t.rounds_per_fight}</td><td style="color:#8b949e">@\${esc(t.requester_username)}</td><td style="color:#6e7681;font-size:11px">\${esc(t.finished_at || '')}</td></tr>\`).join('')}</table>\` : '';
  const ownersHtml = (f.owners && f.owners.length) ? \`<h2 style="margin-top:16px;font-size:12px;text-transform:uppercase;color:#8b949e">Owner history</h2><table>\${f.owners.map(o => {
    const bot = o.owner_is_bot ? \` <span style="color:#8b949e;font-size:10px;background:#21262d;border-radius:3px;padding:1px 4px">BOT</span>\` : '';
    const status = o.is_retired ? '<span style="color:#6e7681">retired</span>' : '<span style="color:#3fb950">current</span>';
    return \`<tr><td style="white-space:nowrap"><a href="/team/\${o.team_id}">\${esc(o.team_name)}</a> <span style="color:#8b949e">@\${esc(o.owner_username)}</span>\${bot}</td><td style="color:#8b949e;font-size:11px">\${esc(o.joined_at || '')}</td><td>\${status}</td><td style="color:#6e7681;font-size:11px">\${esc(o.reason || '')}</td></tr>\`;
  }).join('')}</table>\` : '';
  document.getElementById('modal-body').innerHTML = \`
    <div class="head">
      <img class="portrait" src="/portrait/\${encodeURIComponent(f.file_name)}.png" onerror="this.style.visibility='hidden'">
      <div style="flex:1">
        <h3 style="display:flex;align-items:center;gap:10px;margin:0">
          <span>\${esc(f.display_name || f.file_name)}</span>
          <button id="modal-star" title="\${starTip}" style="background:none;border:0;font-size:22px;cursor:pointer;color:\${starColor};padding:0;line-height:1">\${starGlyph}</button>
        </h3>
        <div class="sub">\${esc(f.author || 'unknown author')}</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">\${f.matches_won}</div><div class="l">Wins</div></div>
      <div class="stat"><div class="v">\${f.matches_lost}</div><div class="l">Losses</div></div>
      <div class="stat"><div class="v">\${f.matches_drawn}</div><div class="l">Draws</div></div>
      <div class="stat"><div class="v">\${f.win_rate}%</div><div class="l">Win rate</div></div>
      <div class="stat"><div class="v">\${f.tournament_wins || 0}</div><div class="l">🏆 Tourneys</div></div>
    </div>
    <div class="field"><b>File name:</b> \${esc(f.file_name)}</div>
    <div class="field"><b>Added:</b> \${esc(f.created_at || '-')}</div>
    \${f.source_url ? \`<div class="field"><b>Source:</b> <a href="\${esc(f.source_url)}" target="_blank">\${esc(f.source_url)}</a></div>\` : ''}
    \${f.validation_reason ? \`<div class="field"><b>Issue:</b> <span style="color:#f85149">\${esc(f.validation_reason)}</span></div>\` : ''}
    \${recent ? \`<h2 style="margin-top:16px;font-size:12px;text-transform:uppercase;color:#8b949e">Recent fights</h2><table>\${recent}</table>\` : ''}
    \${tourneyWinsHtml}
    \${ownersHtml}
  \`;
  const starBtn = document.getElementById('modal-star');
  if (starBtn) starBtn.onclick = () => toggleFollowMaster(f.id, starBtn);
  document.getElementById('modal-bg').classList.add('open');
}
function closeModal() { document.getElementById('modal-bg').classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
</script>`;

const LEADERBOARD_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Leaderboard · MugenBattle</title>
<style>${COMMON_CSS}
  .controls { display: flex; gap: 12px; margin-bottom: 12px; align-items: center; }
  input[type=search] { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; font-size: 13px; flex: 1; }
  .rank { color: #6e7681; width: 40px; }
</style></head>
<body>
<h1>🏆 Leaderboard</h1>
<nav>
  <a href="/">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/leaderboard" class="active">Leaderboard</a>
</nav>
<div class="panel">
  <div class="controls">
    <input type="search" id="q" placeholder="Search fighter or author...">
    <span id="count" style="color:#8b949e;font-size:12px">—</span>
  </div>
  <table id="lb">
    <thead><tr>
      <th data-k="rank" class="rank">#</th>
      <th data-k="name">Fighter</th>
      <th data-k="matches_won">W</th>
      <th data-k="matches_lost">L</th>
      <th data-k="matches_drawn">D</th>
      <th data-k="total_matches">Total</th>
      <th data-k="win_rate">Win%</th>
    </tr></thead>
    <tbody></tbody>
  </table>
</div>
${MODAL_HTML}
<script>
function esc(s){return String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
let all = [];
let sortKey = 'matches_won'; let sortDir = -1;
async function load() {
  const r = await fetch('/api/leaderboard'); all = await r.json();
  render();
}
function render() {
  const q = (document.getElementById('q').value || '').toLowerCase().trim();
  let filtered = q ? all.filter(f => ((f.display_name||'')+(f.file_name||'')+(f.author||'')).toLowerCase().includes(q)) : all;
  filtered.sort((a, b) => {
    if (sortKey === 'name') return (a.display_name || a.file_name).localeCompare(b.display_name || b.file_name) * sortDir;
    return ((a[sortKey] || 0) - (b[sortKey] || 0)) * sortDir;
  });
  document.getElementById('count').textContent = \`\${filtered.length} fighter\${filtered.length === 1 ? '' : 's'}\`;
  const rows = filtered.map((f, i) => \`
    <tr class="clickable" onclick="openProfile('\${esc(f.file_name).replace(/'/g,'\\\\\\'')}')">
      <td class="rank">\${i + 1}</td>
      <td>\${esc(f.display_name || f.file_name)}<div class="author">\${esc(f.author || '')}</div></td>
      <td>\${f.matches_won}</td>
      <td>\${f.matches_lost}</td>
      <td>\${f.matches_drawn}</td>
      <td>\${f.total_matches}</td>
      <td>\${f.win_rate}%</td>
    </tr>\`).join('');
  document.querySelector('#lb tbody').innerHTML = rows;
}
document.querySelectorAll('th[data-k]').forEach(th => {
  th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'name' ? 1 : -1; }
    render();
  };
});
document.getElementById('q').addEventListener('input', render);
load();
</script>
</body></html>`;

// ---------- Shared auth fragments ----------

/** Empty slot for the current-user label + sign-in/out button. Filled in by AUTH_JS. */
const AUTH_BAR_HTML = `<div class="auth-bar" id="auth-bar"></div>`;

/** Sign-in modal (email → code → username steps). AUTH_JS drives it. */
const AUTH_MODAL_HTML = `
<div class="modal-bg" id="auth-modal" onclick="if(event.target===this)closeAuth()">
  <div class="modal"><div class="modal-shell">
    <div class="close" onclick="closeAuth()">×</div>
    <h3>Sign in</h3>
    <div class="sub">We'll email you a 6-digit code. No password.</div>
    <div class="auth-form" id="auth-step-email">
      <input type="email" id="auth-email" placeholder="you@example.com" autocomplete="email">
      <button onclick="authSendCode()">Send code</button>
      <div class="msg" id="auth-msg-1"></div>
    </div>
    <div class="auth-form" id="auth-step-code" style="display:none">
      <input type="text" id="auth-code" placeholder="6-digit code" maxlength="6" inputmode="numeric" autocomplete="one-time-code">
      <button onclick="authVerifyCode()">Verify</button>
      <div class="msg" id="auth-msg-2"></div>
    </div>
    <div class="auth-form" id="auth-step-username" style="display:none">
      <div class="sub" style="margin-bottom:2px">Pick a display name. This is the only thing other people will see.</div>
      <input type="text" id="auth-username" placeholder="username" maxlength="20" autocomplete="username">
      <button onclick="authSetUsername()">Save</button>
      <div class="msg" id="auth-msg-3"></div>
    </div>
  </div></div>
</div>`;

/** Auth client-side logic. Self-contained — needs only #auth-bar + AUTH_MODAL_HTML present. */
const AUTH_JS = `<script>
function _escAuth(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }
function _showAuthStep(which) {
  for (const s of ['email', 'code', 'username']) {
    document.getElementById('auth-step-' + s).style.display = (s === which) ? '' : 'none';
  }
  for (const i of [1, 2, 3]) document.getElementById('auth-msg-' + i).textContent = '';
}
async function refreshAuth() {
  const r = await fetch('/api/auth/me');
  const me = await r.json();
  const bar = document.getElementById('auth-bar');
  if (me.authenticated) {
    if (me.needs_username) {
      bar.innerHTML = '<button onclick="openAuth()">Pick username</button>';
      openAuth();
      _showAuthStep('username');
    } else {
      bar.innerHTML = '<span class="user-email">' + _escAuth(me.username) + '</span>' +
        '<button class="logout" onclick="authLogout()">Sign out</button>';
    }
  } else {
    bar.innerHTML = '<button onclick="openAuth()">Sign in</button>';
  }
  window.__authState = me;
  if (window.onAuthStateChange) window.onAuthStateChange(me);
}
function openAuth() {
  _showAuthStep('email');
  document.getElementById('auth-modal').classList.add('open');
  setTimeout(() => document.getElementById('auth-email').focus(), 50);
}
function closeAuth() { document.getElementById('auth-modal').classList.remove('open'); }
async function authSendCode() {
  const email = document.getElementById('auth-email').value.trim();
  const msg = document.getElementById('auth-msg-1');
  msg.className = 'msg'; msg.textContent = 'Sending…';
  const r = await fetch('/api/auth/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  const body = await r.json();
  if (r.ok) {
    document.getElementById('auth-step-email').style.display = 'none';
    document.getElementById('auth-step-code').style.display = '';
    document.getElementById('auth-msg-2').className = 'msg ok';
    document.getElementById('auth-msg-2').textContent = 'Code sent. Check your email.';
    setTimeout(() => document.getElementById('auth-code').focus(), 50);
  } else {
    msg.className = 'msg err';
    msg.textContent = body.error || 'Failed to send code';
  }
}
async function authVerifyCode() {
  const email = document.getElementById('auth-email').value.trim();
  const code = document.getElementById('auth-code').value.trim();
  const msg = document.getElementById('auth-msg-2');
  msg.className = 'msg'; msg.textContent = 'Verifying…';
  const r = await fetch('/api/auth/verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }) });
  const body = await r.json();
  if (!r.ok) {
    msg.className = 'msg err';
    msg.textContent = body.error || 'Failed to verify';
    return;
  }
  if (body.needs_username) {
    _showAuthStep('username');
    setTimeout(() => document.getElementById('auth-username').focus(), 50);
  } else {
    closeAuth();
    refreshAuth();
  }
}
async function authSetUsername() {
  const username = document.getElementById('auth-username').value.trim();
  const msg = document.getElementById('auth-msg-3');
  msg.className = 'msg'; msg.textContent = 'Saving…';
  const r = await fetch('/api/auth/set-username', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const body = await r.json();
  if (r.ok) {
    closeAuth();
    refreshAuth();
  } else {
    msg.className = 'msg err';
    msg.textContent = body.error || 'Could not save';
  }
}
async function authLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  refreshAuth();
}
refreshAuth();
</script>`;

const SCOUT_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Scout · MugenBattle</title>
<style>${COMMON_CSS}
  .scout-hdr { padding: 14px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 16px; }
  .scout-hdr h2 { margin: 0 0 4px; font-size: 22px; color: #c9d1d9; }
  .scout-hdr .user { color: #8b949e; font-size: 13px; }
  .scout-hdr .badge { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 4px; background: #21262d; color: #6e7681; margin-left: 8px; text-transform: uppercase; letter-spacing: 0.3px; vertical-align: middle; }
  .roster-section h3 { font-size: 12px; text-transform: uppercase; color: #8b949e; margin: 16px 0 6px; letter-spacing: 0.4px; }
  .scout-row { display: grid; grid-template-columns: 44px 2fr 2fr 1fr 0.8fr; gap: 12px; padding: 8px 14px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 4px; font-size: 13px; align-items: center; }
  .scout-row .fr-port { width: 44px; height: 44px; background: #0d1117; border-radius: 4px; object-fit: contain; image-rendering: pixelated; border: 1px solid #21262d; }
  .scout-row .fr-name { font-weight: 600; color: #c9d1d9; }
  .scout-row .fr-master { color: #8b949e; font-size: 12px; font-style: italic; }
  .scout-row .fr-stats { color: #8b949e; font-size: 12px; font-variant-numeric: tabular-nums; text-align: center; }
  .scout-row .fr-price { color: #f0ae3c; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
</style></head>
<body style="position:relative">
${AUTH_BAR_HTML}
<h1>🔍 Scout</h1>
<nav>
  <a href="/">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market">Market</a>
  <a href="/exhibition">Exhibition</a>
  <a href="/trades">Trades</a>
  <a href="/tournaments">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>

<div id="root"></div>

${AUTH_MODAL_HTML}
${AUTH_JS}
<script>
function esc(s){return String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
function fmtCents(n){return n === 0 ? '$0.00' : '$' + (n/100).toFixed(2)}
const teamId = Number(location.pathname.split('/').pop());

async function load() {
  const r = await fetch('/api/team/' + teamId);
  const root = document.getElementById('root');
  if (!r.ok) {
    root.innerHTML = '<div style="padding:40px;text-align:center;color:#8b949e">Team not found.</div>';
    return;
  }
  const t = await r.json();
  const active = t.fighters.filter(f => f.slot === 'active').sort((a,b) => a.priority - b.priority || a.id - b.id);
  const bench  = t.fighters.filter(f => f.slot === 'bench' ).sort((a,b) => a.id - b.id);
  const forSale = t.fighters.filter(f => f.slot === 'for_sale');
  const rowHtml = (f) => {
    const master = f.master_display_name || f.master_file_name || '—';
    const right = f.slot === 'for_sale' && f.listing_price_cents != null
      ? '<div class="fr-price">' + fmtCents(f.listing_price_cents) + '</div>'
      : '<div class="fr-stats">stamina ' + Number(f.stamina || 0).toFixed(2) + '</div>';
    const portraitSrc = f.master_file_name ? '/portrait/' + encodeURIComponent(f.master_file_name) + '.png' : '';
    const portrait = portraitSrc
      ? '<img class="fr-port" src="' + portraitSrc + '" alt="" onerror="this.style.visibility=\\'hidden\\'">'
      : '<div class="fr-port"></div>';
    return '<div class="scout-row">' +
      portrait +
      '<div class="fr-name">' + esc(f.display_name) + '</div>' +
      '<div class="fr-master">' + esc(master) + '</div>' +
      '<div class="fr-stats">' + f.matches_won + '-' + f.matches_lost + '-' + f.matches_drawn + '</div>' +
      right +
    '</div>';
  };
  root.innerHTML =
    '<div class="scout-hdr">' +
      '<h2>' + esc(t.name) + '</h2>' +
      '<div class="user">team #' + t.id + '</div>' +
    '</div>' +
    '<div class="roster-section">' +
      '<h3>Active lineup</h3>' +
      (active.length ? active.map(rowHtml).join('') : '<div style="color:#6e7681;font-size:12px">(none)</div>') +
    '</div>' +
    '<div class="roster-section">' +
      '<h3>Bench</h3>' +
      (bench.length ? bench.map(rowHtml).join('') : '<div style="color:#6e7681;font-size:12px">(none)</div>') +
    '</div>' +
    (forSale.length ? '<div class="roster-section"><h3>For sale</h3>' + forSale.map(rowHtml).join('') + '</div>' : '');
}
load();
</script>
</body></html>`;

const TRADES_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Trades · MugenBattle</title>
<style>${COMMON_CSS}
  .tr-controls { display: flex; gap: 12px; margin-bottom: 12px; align-items: center; font-size: 12px; color: #8b949e; }
  .tr-pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: tr-pulse 1.6s infinite; }
  @keyframes tr-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .tr-feed { display: flex; flex-direction: column; gap: 6px; }
  .tr-row { display: grid; grid-template-columns: 110px 32px 1fr 90px 100px; gap: 12px; align-items: center;
    padding: 10px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; font-size: 13px; }
  .tr-row.fresh { border-color: #3fb950; background: #1b2620; animation: tr-flash 1.2s ease-out; }
  @keyframes tr-flash { 0% { background: #2d4434; } 100% { background: #1b2620; } }
  .tr-row .when { color: #6e7681; font-size: 11px; }
  .tr-row .pic { width: 32px; height: 32px; image-rendering: pixelated; object-fit: contain;
    background: #0d1117; border-radius: 4px; }
  .tr-row .pic.empty { background: #0d1117; }
  .tr-row .desc { color: #c9d1d9; line-height: 1.3; }
  .tr-row .desc .actor { color: #58a6ff; }
  .tr-row .desc .bot { color: #8b949e; font-size: 10px; padding: 1px 4px; background: #21262d; border-radius: 3px; margin-left: 3px; vertical-align: middle; }
  .tr-row .desc .arrow { color: #8b949e; margin: 0 6px; }
  .tr-row .desc .master { color: #c9d1d9; font-weight: 600; }
  .tr-row .desc .author { color: #6e7681; font-size: 11px; }
  .tr-row .price { font-variant-numeric: tabular-nums; text-align: right; color: #3fb950; font-weight: 600; }
  .tr-row .price.free { color: #6e7681; }
  .tr-row .kind { text-align: right; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: #8b949e; }
  .tr-row .kind.buy_unclaimed { color: #d29922; }
  .tr-row .kind.buy_listing { color: #58a6ff; }
  .tr-row .kind.release { color: #db6d28; }
  .tr-row .kind.list { color: #a371f7; }
  .tr-row.release .price { color: #6e7681; }
  @media (max-width: 700px) {
    .tr-row { grid-template-columns: 32px 1fr 80px; gap: 8px; }
    .tr-row .when, .tr-row .kind { display: none; }
  }
  .tr-empty { color: #6e7681; padding: 30px; text-align: center; font-size: 13px; }
  .tr-row .actor { color: #58a6ff; text-decoration: none; }
  .tr-row .actor:hover { text-decoration: underline; }
  .tr-row .master.clickable, .tr-row .pic.clickable { cursor: pointer; }
  .tr-row .master.clickable:hover { color: #58a6ff; }
  .tr-row .pic.clickable:hover { outline: 1px solid #58a6ff; }
</style></head>
<body>
<h1>📈 Trades</h1>
<nav>
  <a href="/">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market">Market</a>
  <a href="/exhibition">Exhibition</a>
  <a href="/trades" class="active">Trades</a>
  <a href="/tournaments">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>
<div class="tr-controls">
  <span class="tr-pulse"></span>
  <span id="tr-status">Loading…</span>
  <span style="color:#6e7681">Polls every 8s · most recent first</span>
</div>
<div class="tr-feed" id="tr-feed"></div>

<div class="modal-bg" id="modal-bg" onclick="if(event.target.id==='modal-bg')closeModal()">
  <div class="modal modal-shell">
    <div class="close" onclick="closeModal()">×</div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let lastSeenId = 0;

let followedMastersCache = null;
async function loadFollowedMasters() {
  if (followedMastersCache) return followedMastersCache;
  try {
    const r = await fetch('/api/follow');
    if (!r.ok) { followedMastersCache = new Set(); return followedMastersCache; }
    const j = await r.json();
    followedMastersCache = new Set(j.masters || []);
  } catch { followedMastersCache = new Set(); }
  return followedMastersCache;
}
async function toggleFollowMaster(masterId, btn) {
  const set = await loadFollowedMasters();
  const isOn = set.has(masterId);
  if (isOn) {
    await fetch('/api/follow/master/' + masterId, { method: 'DELETE' });
    set.delete(masterId);
    btn.textContent = '☆'; btn.title = 'Follow'; btn.style.color = '#8b949e';
  } else {
    const r = await fetch('/api/follow', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ kind: 'master', id: masterId }) });
    if (r.status === 401) { alert('Sign in to follow fighters.'); return; }
    set.add(masterId);
    btn.textContent = '★'; btn.title = 'Unfollow'; btn.style.color = '#f0ae3c';
  }
}
async function openProfile(fileName) {
  const r = await fetch('/api/fighter/' + encodeURIComponent(fileName));
  if (!r.ok) return;
  const f = await r.json();
  const followed = await loadFollowedMasters();
  const isFollowed = followed.has(f.id);
  const starGlyph = isFollowed ? '★' : '☆';
  const starColor = isFollowed ? '#f0ae3c' : '#8b949e';
  const starTip = isFollowed ? 'Unfollow' : 'Follow';
  const recent = (f.recent || []).map((m) => {
    const winLose = m.victor === f.display_name || m.victor_file === f.file_name ? 'W' : (m.victor ? 'L' : 'D');
    const isF1 = (m.f1 === (f.display_name || f.file_name)) || (m.f1_file === f.file_name);
    const opp = isF1 ? m.f2 : m.f1;
    const oppFile = isF1 ? m.f2_file : m.f1_file;
    const oppCell = oppFile
      ? 'vs <span style="cursor:pointer;color:#58a6ff;text-decoration:underline" onclick=\\'openProfile(' + JSON.stringify(oppFile) + ')\\'>' + esc(opp || '?') + '</span>' 
      : 'vs ' + esc(opp || '?');
    return '<tr><td>' + winLose + '</td><td>' + oppCell + '</td><td style="color:#8b949e">' + esc(m.stage || '') + '</td></tr>';
  }).join('');
  const reasonLabel = (r) => {
    if (!r) return '';
    if (r === 'created') return 'starter roster';
    if (r === 'bought_from_market') return 'bought from pool';
    if (r === 'bought_from_user') return 'bought from owner';
    if (r === 'auto_replenish') return 'auto-replenished';
    if (r === 'replaced_extra_kfm') return 'replaced training dummy';
    if (r === 'boot_sweep') return 'boot recovery';
    if (r.startsWith('kfm_replacement:repeated_crash')) return 'system-replaced (crash)';
    if (r.startsWith('kfm_replacement:')) return 'system-replaced';
    return r;
  };
  const stateLabel = (s) => {
    if (s === 'current') return '<span style="color:#3fb950">current</span>';
    if (s === 'released') return '<span style="color:#d29922">released</span>';
    if (s === 'sold') return '<span style="color:#58a6ff">sold</span>';
    return '<span style="color:#6e7681">' + s + '</span>';
  };
  const ownersHtml = (f.owners && f.owners.length)
    ? '<h2 style="margin-top:16px;font-size:12px;text-transform:uppercase;color:#8b949e">Owner history</h2><table>' +
      f.owners.map(o => {
        const bot = o.owner_is_bot ? ' <span style="color:#8b949e;font-size:10px;background:#21262d;border-radius:3px;padding:1px 4px">BOT</span>' : '';
        return '<tr><td style="white-space:nowrap"><a href="/team/' + o.team_id + '">' + esc(o.team_name) + '</a> <span style="color:#8b949e">@' + esc(o.owner_username) + '</span>' + bot + '</td><td style="color:#8b949e;font-size:11px">' + esc(o.joined_at || '') + '</td><td>' + stateLabel(o.state) + '</td><td style="color:#6e7681;font-size:11px">' + esc(reasonLabel(o.reason)) + '</td></tr>';
      }).join('') + '</table>'
    : '';
  document.getElementById('modal-body').innerHTML =
    '<div class="head">' +
      '<img class="portrait" src="/portrait/' + encodeURIComponent(f.file_name) + '.png" onerror="this.style.visibility=\\'hidden\\'">' +
      '<div style="flex:1"><h3 style="display:flex;align-items:center;gap:10px;margin:0">' +
      '<span>' + esc(f.display_name || f.file_name) + '</span>' +
      '<button id="modal-star" title="' + starTip + '" style="background:none;border:0;font-size:22px;cursor:pointer;color:' + starColor + ';padding:0;line-height:1">' + starGlyph + '</button>' +
      '</h3>' +
      '<div class="sub">' + esc(f.author || 'unknown author') + '</div></div></div>' +
    '<div class="stats">' +
      '<div class="stat"><div class="v">' + f.matches_won + '</div><div class="l">Wins</div></div>' +
      '<div class="stat"><div class="v">' + f.matches_lost + '</div><div class="l">Losses</div></div>' +
      '<div class="stat"><div class="v">' + f.matches_drawn + '</div><div class="l">Draws</div></div>' +
      '<div class="stat"><div class="v">' + f.win_rate + '%</div><div class="l">Win rate</div></div></div>' +
    '<div class="field"><b>File name:</b> ' + esc(f.file_name) + '</div>' +
    '<div class="field"><b>Added:</b> ' + esc(f.created_at || '-') + '</div>' +
    (f.source_url ? '<div class="field"><b>Source:</b> <a href="' + esc(f.source_url) + '" target="_blank">' + esc(f.source_url) + '</a></div>' : '') +
    (recent ? '<h2 style="margin-top:16px;font-size:12px;text-transform:uppercase;color:#8b949e">Recent fights</h2><table>' + recent + '</table>' : '') + tourneyWinsHtml + ownersHtml;
  const sb = document.getElementById('modal-star');
  if (sb) sb.onclick = () => toggleFollowMaster(f.id, sb);
  document.getElementById('modal-bg').classList.add('open');
}
function closeModal() { document.getElementById('modal-bg').classList.remove('open'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function relTime(iso) {
  const t = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const dt = (Date.now() - t) / 1000;
  if (dt < 5) return 'just now';
  if (dt < 60) return Math.floor(dt) + 's ago';
  if (dt < 3600) return Math.floor(dt/60) + 'm ago';
  if (dt < 86400) return Math.floor(dt/3600) + 'h ago';
  return Math.floor(dt/86400) + 'd ago';
}

function userTag(u) {
  if (!u) return '<span style="color:#6e7681">(unknown)</span>';
  const bot = u.is_bot ? '<span class="bot">BOT</span>' : '';
  const name = '@' + esc(u.username);
  const link = u.team_id
    ? '<a class="actor" href="/team/' + u.team_id + '">' + name + '</a>'
    : '<span class="actor">' + name + '</span>';
  return link + bot;
}

function rowHtml(t, isFresh) {
  // Both the portrait and the name open the fighter profile modal — same
  // pattern the leaderboard uses. The escape-quotes-in-onclick gymnastics
  // are because file_name can contain spaces/parens/quotes.
  const fnAttr = t.master ? esc(t.master.file_name).replace(/'/g, "\\'") : '';
  const pic = t.master
    ? '<img class="pic clickable" onclick="openProfile(\\'' + fnAttr + '\\')" src="/portrait/' + encodeURIComponent(t.master.file_name) + '.png" onerror="this.classList.add(\\'empty\\');this.removeAttribute(\\'src\\')">'
    : '<div class="pic empty"></div>';
  const masterLabel = t.master
    ? '<span class="master clickable" onclick="openProfile(\\'' + fnAttr + '\\')">' + esc(t.master.display_name || t.master.file_name) + '</span>'
      + (t.master.author ? ' <span class="author">· ' + esc(t.master.author) + '</span>' : '')
    : '<span style="color:#6e7681">(unknown fighter)</span>';

  let descHtml, priceTxt, priceCls, kindLabel;
  if (t.kind === 'buy_unclaimed') {
    descHtml = userTag(t.buyer) + ' bought ' + masterLabel + ' from the unclaimed pool';
    kindLabel = 'unclaimed';
  } else if (t.kind === 'release') {
    descHtml = userTag(t.seller) + ' released ' + masterLabel + ' back to the unclaimed pool';
    kindLabel = 'released';
  } else if (t.kind === 'list') {
    descHtml = userTag(t.seller) + ' listed ' + masterLabel + ' for sale';
    kindLabel = 'listed';
  } else {
    descHtml = userTag(t.buyer) + ' bought ' + masterLabel
      + '<span class="arrow">←</span>' + userTag(t.seller);
    kindLabel = 'listing';
  }
  if (t.kind === 'release') { priceTxt = '—'; priceCls = 'free'; }
  else if (t.price_cents > 0) { priceTxt = '$' + (t.price_cents/100).toFixed(2); priceCls = ''; }
  else { priceTxt = 'free'; priceCls = 'free'; }
  return '<div class="tr-row ' + t.kind + (isFresh ? ' fresh' : '') + '" data-id="' + t.id + '">' +
    '<div class="when" title="' + esc(t.created_at) + '">' + relTime(t.created_at) + '</div>' +
    pic +
    '<div class="desc">' + descHtml + '</div>' +
    '<div class="price ' + priceCls + '">' + priceTxt + '</div>' +
    '<div class="kind ' + t.kind + '">' + kindLabel + '</div>' +
  '</div>';
}

async function refresh() {
  try {
    const r = await fetch('/api/trades?limit=50');
    if (!r.ok) throw new Error('http ' + r.status);
    const trades = await r.json();
    const host = document.getElementById('tr-feed');
    if (!trades.length) {
      host.innerHTML = '<div class="tr-empty">No trades yet — waiting for the first market move…</div>';
      document.getElementById('tr-status').textContent = 'Waiting…';
      return;
    }
    const newestId = trades[0].id;
    host.innerHTML = trades.map((t) => rowHtml(t, t.id > lastSeenId && lastSeenId > 0)).join('');
    lastSeenId = newestId;
    document.getElementById('tr-status').textContent = 'Last update: ' + new Date().toLocaleTimeString();
  } catch (err) {
    document.getElementById('tr-status').textContent = 'Refresh failed: ' + err.message;
  }
}

refresh();
setInterval(refresh, 8000);
</script>
</body></html>`;

const EXHIBITION_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Exhibition · MugenBattle</title>
<style>${COMMON_CSS}
  .ex-row { display: grid; grid-template-columns: 1fr 80px 1fr; gap: 16px; align-items: stretch; }
  @media (max-width: 800px) { .ex-row { grid-template-columns: 1fr; } }
  .ex-side { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; }
  .ex-side h2 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #8b949e; }
  .ex-vs { display: flex; align-items: center; justify-content: center; font-size: 22px; color: #6e7681; }
  .ex-tabs { display: flex; gap: 0; margin-bottom: 8px; border-bottom: 1px solid #30363d; }
  .ex-tab { padding: 6px 10px; font-size: 12px; color: #8b949e; cursor: pointer; border-bottom: 2px solid transparent; }
  .ex-tab.active { color: #c9d1d9; border-bottom-color: #58a6ff; }
  .ex-tab .count { color: #6e7681; margin-left: 4px; }
  .ex-search { width: 100%; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; font-size: 12px; margin-bottom: 8px; box-sizing: border-box; }
  .ex-list { max-height: 360px; overflow-y: auto; border: 1px solid #21262d; border-radius: 6px; }
  .ex-item { padding: 8px 10px; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px solid #21262d; font-size: 12px; }
  .ex-item:last-child { border-bottom: 0; }
  .ex-item:hover { background: #1d232b; }
  .ex-item.selected { background: #1f6feb33; border-color: #1f6feb; }
  .ex-item.mine { background: #2da44e1a; }
  .ex-item.mine.selected { background: #2da44e44; }
  .ex-item.followed { border-left: 2px solid #f0ae3c; }
  .ex-item .name { color: #c9d1d9; font-weight: 600; }
  .ex-item .meta { color: #8b949e; font-size: 11px; }
  .ex-item .stats { color: #6e7681; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ex-selected { margin-top: 10px; padding: 8px 10px; background: #0d1117; border-radius: 6px; min-height: 32px; font-size: 12px; }
  .ex-selected.empty { color: #6e7681; font-style: italic; }
  .ex-actions { margin: 18px 0; display: flex; gap: 12px; align-items: center; justify-content: center; }
  .ex-btn { background: #238636; color: #fff; border: 0; padding: 10px 22px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .ex-btn:disabled { background: #30363d; color: #6e7681; cursor: not-allowed; }
  .ex-btn:hover:not(:disabled) { background: #2ea043; }
  .ex-status { font-size: 12px; color: #8b949e; }
  .ex-stream-wrap { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; margin-top: 18px; }
  .ex-stream-wrap.hidden { display: none; }
  .ex-stream-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .ex-stream-hdr h2 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #8b949e; }
  .ex-stream { background: #000; aspect-ratio: 4 / 3; max-width: 800px; margin: 0 auto; }
  .ex-stream img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; display: block; }
  .ex-stream .placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: #6e7681; font-size: 14px; }
  .ex-result { padding: 12px; background: #0d1117; border-radius: 6px; margin-top: 10px; font-size: 13px; }
  .ex-result .winner { color: #3fb950; font-weight: 600; }
  .ex-result .loser  { color: #f85149; }
  .ex-result .draw   { color: #d29922; }
  .ex-history { margin-top: 22px; }
  .ex-history h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #8b949e; margin: 0 0 8px; }
  .ex-history-row { display: grid; grid-template-columns: 90px 1fr 60px 1fr 50px; gap: 8px; padding: 6px 4px; border-bottom: 1px solid #21262d; font-size: 12px; align-items: center; }
  .ex-history-row .res.W { color: #3fb950; }
  .ex-history-row .res.L { color: #f85149; }
  .ex-history-row .res.D { color: #d29922; }
  .ex-history-row .res.F { color: #6e7681; }
  .ex-history-row .when { color: #6e7681; font-size: 11px; }
  .live-pill-ex { display: inline-block; padding: 2px 8px; background: #da3633; color: #fff; border-radius: 999px; font-size: 11px; font-weight: 600; animation: live-pulse 1.6s infinite; }
  @keyframes live-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
  .mode-tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid #30363d; }
  .mode-tab { padding: 10px 20px; font-size: 14px; font-weight: 600; color: #8b949e; cursor: pointer; border-bottom: 2px solid transparent; user-select: none; }
  .mode-tab.active { color: #c9d1d9; border-bottom-color: #f0ae3c; }
  .mode-tab:hover:not(.active) { color: #c9d1d9; }
  .tn-toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 12px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 14px; }
  .tn-toolbar .lbl { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.4px; }
  .tn-size { display: flex; gap: 4px; }
  .tn-size button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 5px 12px; border-radius: 5px; cursor: pointer; font-size: 12px; }
  .tn-size button.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .tn-toolbar .tn-btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 5px 12px; border-radius: 5px; cursor: pointer; font-size: 12px; }
  .tn-toolbar .tn-btn:hover { background: #30363d; }
  .tn-toolbar .tn-btn.primary { background: #238636; border-color: #2ea043; color: #fff; }
  .tn-toolbar .tn-btn.primary:hover:not(:disabled) { background: #2ea043; }
  .tn-toolbar .tn-btn:disabled { background: #21262d; color: #6e7681; cursor: not-allowed; border-color: #30363d; }
  .tn-toolbar .tn-status { color: #8b949e; font-size: 12px; margin-left: auto; }
  .tn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: stretch; }
  @media (max-width: 800px) { .tn-row { grid-template-columns: 1fr; } }
  .tn-side { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; }
  .tn-side h2 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #8b949e; }
  .tn-slots { display: grid; grid-template-columns: 1fr; gap: 6px; max-height: 480px; overflow-y: auto; }
  .tn-slot { display: grid; grid-template-columns: 28px 1fr auto; gap: 8px; align-items: center; padding: 8px 10px; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .tn-slot:hover { border-color: #58a6ff; }
  .tn-slot.active { border-color: #f0ae3c; background: #1d232b; }
  .tn-slot.empty .tn-slot-name { color: #6e7681; font-style: italic; }
  .tn-slot .tn-slot-num { color: #8b949e; font-variant-numeric: tabular-nums; text-align: right; }
  .tn-slot .tn-slot-name { color: #c9d1d9; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tn-slot .tn-slot-meta { color: #8b949e; font-size: 11px; margin-left: 4px; font-weight: 400; }
  .tn-slot .tn-slot-clear { color: #6e7681; font-size: 14px; padding: 0 4px; cursor: pointer; }
  .tn-slot .tn-slot-clear:hover { color: #f85149; }
  .tn-bracket-wrap { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; margin-top: 16px; }
  .tn-bracket-wrap.hidden { display: none; }
  .tn-bracket-wrap h2 { margin: 0 0 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #8b949e; }
  .tn-bracket-scroll { overflow-x: auto; padding-bottom: 8px; }
  .tn-bracket-titles { display: flex; }
  .tn-bracket-titles > div { font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.4px; text-align: center; margin-bottom: 8px; }
  .tn-bracket { position: relative; }
  .tn-bracket .tn-match { position: absolute; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; font-size: 12px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; }
  .tn-bracket .tn-match.tn-champion { border-color: #f0ae3c; background: #1d232b; }
  .tn-bracket .tn-match.tn-running { border-color: #da3633; box-shadow: 0 0 0 2px rgba(218,54,51,0.25); animation: tn-running-pulse 1.6s infinite; }
  .tn-bracket .tn-match.tn-done { border-color: #21262d; }
  .tn-bracket .tn-match .tn-fighter.winner { color: #3fb950; font-weight: 600; }
  .tn-bracket .tn-match .tn-fighter.loser { color: #6e7681; text-decoration: line-through; }
  @keyframes tn-running-pulse { 0%,100% { box-shadow: 0 0 0 2px rgba(218,54,51,0.25); } 50% { box-shadow: 0 0 0 3px rgba(218,54,51,0.5); } }
  .tn-bracket .tn-coinflip { cursor: help; font-size: 11px; opacity: 0.85; }
  .tn-bracket .tn-match .tn-fighter { padding: 3px 0; color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
  .tn-bracket .tn-match .tn-fighter.tbd { color: #6e7681; font-style: italic; }
  .tn-bracket .tn-match .tn-fighter .seed { color: #6e7681; font-size: 10px; margin-right: 6px; font-variant-numeric: tabular-nums; display: inline-block; min-width: 18px; }
  .tn-bracket-svg { position: absolute; top: 0; left: 0; pointer-events: none; }
  .tn-bracket-svg path { stroke: #30363d; stroke-width: 1.5; fill: none; }
  .tn-rpf { display: flex; align-items: center; gap: 6px; }
  .tn-rpf select { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 5px; padding: 4px 8px; font-size: 12px; cursor: pointer; }
  #tournament-mode.locked .tn-toolbar,
  #tournament-mode.locked .tn-row,
  #tournament-mode.locked > .panel { display: none; }
  .tn-confirm-bar { display: flex; gap: 14px; align-items: center; justify-content: center; margin-top: 14px; padding-top: 14px; border-top: 1px solid #21262d; }
  .tn-confirm-bar.queued { padding-top: 12px; }
  .tn-confirm-bar .ex-btn.danger { background: #da3633; }
  .tn-confirm-bar .ex-btn.danger:hover:not(:disabled) { background: #f85149; }
  .tn-confirm-bar .tn-status { color: #8b949e; font-size: 12px; }
  .tn-queued-banner { background: #1f6feb22; border: 1px solid #1f6feb; border-radius: 6px; padding: 10px 14px; font-size: 13px; color: #c9d1d9; margin-top: 14px; }
  .tn-queued-banner b { color: #58a6ff; }
</style></head>
<body>
<h1>🥋 Exhibition</h1>
<nav>
  <a href="/">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market">Market</a>
  <a href="/exhibition" class="active">Exhibition</a>
  <a href="/trades">Trades</a>
  <a href="/tournaments">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>

<div class="mode-tabs" id="mode-tabs">
  <div class="mode-tab active" data-mode="match">Match</div>
  <div class="mode-tab" data-mode="tournament">Tournament</div>
</div>

<div id="match-mode">
<div class="panel" style="margin-bottom: 16px;">
  <p style="margin: 0; font-size: 13px; color: #8b949e;">
    Pick any two fighters and run a one-off match. Both sides fight at full life — W/L/D records and master stats update, but stamina is untouched so testing your team won't burn their rest. League standings aren't affected.
    Released fighters aren't selectable; buy them back from the market to spar with that master again.
  </p>
</div>

<div class="ex-row">
  <div class="ex-side">
    <h2>Home (P1)</h2>
    <div class="ex-tabs" data-side="home">
      <div class="ex-tab active" data-bucket="mine">My team <span class="count" id="home-count-mine">0</span></div>
      <div class="ex-tab" data-bucket="others">Other teams <span class="count" id="home-count-others">0</span></div>
      <div class="ex-tab" data-bucket="market">Market <span class="count" id="home-count-market">0</span></div>
    </div>
    <input type="search" class="ex-search" id="home-search" placeholder="Search fighter or character...">
  <div class="ex-list" id="home-list"></div>
    <div class="ex-selected empty" id="home-selected">No fighter selected.</div>
  </div>
  <div class="ex-vs">VS</div>
  <div class="ex-side">
    <h2>Away (P2)</h2>
    <div class="ex-tabs" data-side="away">
      <div class="ex-tab active" data-bucket="mine">My team <span class="count" id="away-count-mine">0</span></div>
      <div class="ex-tab" data-bucket="others">Other teams <span class="count" id="away-count-others">0</span></div>
      <div class="ex-tab" data-bucket="market">Market <span class="count" id="away-count-market">0</span></div>
    </div>
    <input type="search" class="ex-search" id="away-search" placeholder="Search fighter or character...">
  <div class="ex-list" id="away-list"></div>
    <div class="ex-selected empty" id="away-selected">No fighter selected.</div>
  </div>
</div>

<div class="ex-actions">
  <button class="ex-btn" id="spar-btn" disabled>Start match</button>
  <span class="ex-status" id="spar-status"></span>
</div>

<div class="ex-stream-wrap hidden" id="stream-wrap">
  <div class="ex-stream-hdr">
    <h2>Match</h2>
    <span id="stream-state"></span>
  </div>
  <div class="ex-stream" id="stream-host"><div class="placeholder">Waiting for worker…</div></div>
  <div id="result-host"></div>
</div>

<div class="ex-history" id="history-host"></div>
</div>

<div id="tournament-mode" hidden>
<div class="panel" style="margin-bottom: 16px;">
  <p style="margin: 0; font-size: 13px; color: #8b949e;">
    Build a single-elimination bracket. Pick a size, then click slots and assign fighters from the picker. Use Auto-fill to seed quickly. Drawn matches are tiebroken by coin flip (🪙) so the bracket can advance.
  </p>
</div>

<div class="tn-toolbar">
  <span class="lbl">Size</span>
  <div class="tn-size" id="tn-size">
    <button data-size="4">4</button>
    <button data-size="8" class="active">8</button>
    <button data-size="16">16</button>
    <button data-size="32">32</button>
    <button data-size="64">64</button>
  </div>
  <span class="tn-rpf"><span class="lbl">Best of</span>
    <select id="tn-rpf">
      <option value="1" selected>1 round</option>
      <option value="3">3 rounds</option>
      <option value="5">5 rounds</option>
    </select>
  </span>
  <span class="tn-rpf"><span class="lbl">Stage</span>
    <select id="tn-stage">
      <option value="" selected>Random per match</option>
    </select>
  </span>
  <button class="tn-btn" id="tn-fill-mine">Auto-fill: my team</button>
  <button class="tn-btn" id="tn-fill-random">Auto-fill: random</button>
  <button class="tn-btn" id="tn-fill-wins">Auto-fill: top wins</button>
  <button class="tn-btn" id="tn-shuffle">Shuffle order</button>
  <button class="tn-btn" id="tn-clear">Clear</button>
  <button class="tn-btn primary" id="tn-generate" disabled>Generate bracket</button>
  <span class="tn-status" id="tn-status">0 / 8 slots filled</span>
</div>

<div class="tn-row">
  <div class="tn-side">
    <h2>Slots</h2>
    <div class="tn-slots" id="tn-slots"></div>
  </div>
  <div class="tn-side">
    <h2>Pick a fighter</h2>
    <div class="ex-tabs" data-side="tn">
      <div class="ex-tab active" data-bucket="mine">My team <span class="count" id="tn-count-mine">0</span></div>
      <div class="ex-tab" data-bucket="others">Other teams <span class="count" id="tn-count-others">0</span></div>
      <div class="ex-tab" data-bucket="market">Market <span class="count" id="tn-count-market">0</span></div>
    </div>
    <input type="search" class="ex-search" id="tn-search" placeholder="Search fighter or character...">
    <div class="ex-list" id="tn-list"></div>
  </div>
</div>

<div class="tn-bracket-wrap hidden" id="tn-bracket-wrap">
  <h2>Bracket <span id="tn-bracket-meta" style="font-weight:400;color:#8b949e;text-transform:none;letter-spacing:0;"></span></h2>
  <div class="tn-bracket-scroll"><div class="tn-bracket" id="tn-bracket"></div></div>
  <div class="ex-stream-wrap hidden" id="tn-stream-wrap" style="margin-top:14px">
    <div class="ex-stream-hdr">
      <h2 id="tn-stream-title">Live match</h2>
      <span class="live-pill-ex">● LIVE</span>
    </div>
    <div class="ex-stream" id="tn-stream-host"><div class="placeholder">Waiting for stream…</div></div>
  </div>
  <div class="tn-confirm-bar" id="tn-confirm-bar">
    <button class="ex-btn" id="tn-start-btn">Confirm and start tournament</button>
    <span class="tn-status" id="tn-confirm-status"></span>
  </div>
</div>
</div>

<script>
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const state = {
  mine: [], others: [], market: [], recent: [],
  signedIn: false,
  activeTab: { home: 'mine', away: 'mine' },
  search: { home: '', away: '' },
  selection: { home: null, away: null },
  pollTimer: null,
};

async function loadFighters() {
  const r = await fetch('/api/exhibition/fighters');
  if (!r.ok) return;
  const d = await r.json();
  state.mine = d.mine || [];
  state.others = d.others || [];
  state.market = d.market || [];
  state.recent = d.recent || [];
  state.signedIn = !!d.signed_in;
  // If user has no team or isn't signed in, default to "Other teams" tab.
  if (state.mine.length === 0) state.activeTab = { home: 'others', away: 'others' };
  document.getElementById('home-count-mine').textContent = state.mine.length;
  document.getElementById('home-count-others').textContent = state.others.length;
  document.getElementById('home-count-market').textContent = state.market.length;
  document.getElementById('away-count-mine').textContent = state.mine.length;
  document.getElementById('away-count-others').textContent = state.others.length;
  document.getElementById('away-count-market').textContent = state.market.length;
  for (const side of ['home', 'away']) {
    const tabs = document.querySelectorAll('.ex-tabs[data-side="' + side + '"] .ex-tab');
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.bucket === state.activeTab[side]));
    renderList(side);
  }
  renderHistory();
  // Populate the stage dropdown for the tournament builder.
  const stageSel = document.getElementById('tn-stage');
  if (stageSel && d.stages) {
    const opts = ['<option value="">Random per match</option>']
      .concat(d.stages.map((s) => '<option value="' + s.id + '">' + esc(s.display_name || s.file_name) + '</option>'));
    stageSel.innerHTML = opts.join('');
  }
  // Hydrate tournament mode from any existing active tournament so reloading
  // the page shows the queued banner instead of a blank picker.
  if (d.active_tournament) {
    tn.queuedId = d.active_tournament.id;
    tn.size = d.active_tournament.size;
    tn.roundsPerFight = d.active_tournament.rounds_per_fight;
    tn.generated = true;
    document.querySelectorAll('#tn-size button').forEach((b) =>
      b.classList.toggle('active', Number(b.dataset.size) === tn.size));
    const rpfSel = document.getElementById('tn-rpf');
    if (rpfSel) rpfSel.value = String(tn.roundsPerFight);
    // Reconstruct the slot fighters from round-0 home/away pairs in order.
    const r0 = d.active_tournament.matches.filter((m) => m.round === 0).sort((a, b) => a.match_index - b.match_index);
    tn.slots = new Array(tn.size).fill(null);
    for (const m of r0) {
      tn.slots[m.match_index * 2] = m.home_owned_fighter_id ? { owned_fighter_id: m.home_owned_fighter_id, display_name: m.home_name, team_name: m.home_team_name } : null;
      tn.slots[m.match_index * 2 + 1] = m.away_owned_fighter_id ? { owned_fighter_id: m.away_owned_fighter_id, display_name: m.away_name, team_name: m.away_team_name } : null;
    }
    tnRenderBracket();
    tnRenderConfirmBar();
    tnStartPolling();
  }
}

function rosterFor(bucket) {
  if (bucket === 'mine') return state.mine;
  if (bucket === 'others') return state.others;
  if (bucket === 'market') return state.market;
  return [];
}

function filterRoster(rows, q) {
  const ql = q.trim().toLowerCase();
  if (!ql) return rows;
  return rows.filter((r) =>
    (r.display_name || '').toLowerCase().includes(ql) ||
    (r.master_display_name || '').toLowerCase().includes(ql) ||
    (r.team_name || '').toLowerCase().includes(ql) ||
    (r.master_author || '').toLowerCase().includes(ql)
  );
}

function rowHtml(r, side) {
  const sel = state.selection[side]?.owned_fighter_id === r.owned_fighter_id ? ' selected' : '';
  const mineCls = state.mine.find((m) => m.owned_fighter_id === r.owned_fighter_id) ? ' mine' : '';
  const followCls = r.followed ? ' followed' : '';
  const star = r.followed ? '<span style="color:#f0ae3c;margin-right:6px" title="Followed">★</span>' : '';
  const stam = Math.round((r.stamina || 0) * 100);
  // Show master lifetime wins inline so the sort order (wins-desc) is visible.
  const masterRec = (r.master_won != null) ? ' · ' + r.master_won + 'w lifetime' : '';
  return '<div class="ex-item' + mineCls + followCls + sel + '" data-id="' + r.owned_fighter_id + '">' +
    '<div>' +
      '<div class="name">' + star + esc(r.display_name) + '</div>' +
      '<div class="meta">' + esc(r.master_display_name || '') + (r.master_author ? ' · ' + esc(r.master_author) : '') + ' · <span style="color:#8b949e">' + esc(r.team_name) + '</span></div>' +
    '</div>' +
    '<div class="stats">' + r.matches_won + 'W ' + r.matches_lost + 'L ' + r.matches_drawn + 'D · ' + stam + '%' + masterRec + '</div>' +
  '</div>';
}

function renderList(side) {
  const list = document.getElementById(side + '-list');
  const bucket = state.activeTab[side];
  const rows = filterRoster(rosterFor(bucket), state.search[side]);
  list.innerHTML = rows.length
    ? rows.map((r) => rowHtml(r, side)).join('')
    : '<div style="padding:12px;color:#6e7681;text-align:center;font-size:12px">No fighters match.</div>';
  list.querySelectorAll('.ex-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.id);
      const all = [...state.mine, ...state.others, ...state.market];
      const f = all.find((x) => x.owned_fighter_id === id);
      if (!f) return;
      state.selection[side] = f;
      renderList(side);
      renderSelected(side);
      updateSparBtn();
    });
  });
}

function renderSelected(side) {
  const host = document.getElementById(side + '-selected');
  const f = state.selection[side];
  if (!f) {
    host.classList.add('empty');
    host.textContent = 'No fighter selected.';
    return;
  }
  host.classList.remove('empty');
  const stam = Math.round((f.stamina || 0) * 100);
  host.innerHTML = '<b>' + esc(f.display_name) + '</b> ' +
    '<span style="color:#8b949e">· ' + esc(f.master_display_name || '') + (f.master_author ? ' (' + esc(f.master_author) + ')' : '') + '</span><br>' +
    '<span style="color:#6e7681">' + esc(f.team_name) + ' · ' + f.matches_won + 'W ' + f.matches_lost + 'L ' + f.matches_drawn + 'D · stamina ' + stam + '%</span>';
}

function updateSparBtn() {
  const btn = document.getElementById('spar-btn');
  const h = state.selection.home;
  const a = state.selection.away;
  if (!h || !a) { btn.disabled = true; return; }
  if (h.owned_fighter_id === a.owned_fighter_id) {
    btn.disabled = true;
    document.getElementById('spar-status').textContent = 'Pick two different fighters.';
    return;
  }
  if (!state.signedIn) {
    btn.disabled = true;
    document.getElementById('spar-status').textContent = 'Sign in to start exhibition matches.';
    return;
  }
  document.getElementById('spar-status').textContent = '';
  btn.disabled = false;
}

document.querySelectorAll('.ex-tabs').forEach((tabs) => {
  tabs.querySelectorAll('.ex-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const side = tabs.dataset.side;
      state.activeTab[side] = tab.dataset.bucket;
      tabs.querySelectorAll('.ex-tab').forEach((t) => t.classList.toggle('active', t === tab));
      renderList(side);
    });
  });
});

['home', 'away'].forEach((side) => {
  document.getElementById(side + '-search').addEventListener('input', (e) => {
    state.search[side] = e.target.value;
    renderList(side);
  });
});

document.getElementById('spar-btn').addEventListener('click', async () => {
  const btn = document.getElementById('spar-btn');
  btn.disabled = true;
  document.getElementById('spar-status').textContent = 'Queuing…';
  const r = await fetch('/api/exhibition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      home_owned_fighter_id: state.selection.home.owned_fighter_id,
      away_owned_fighter_id: state.selection.away.owned_fighter_id,
    }),
  });
  if (!r.ok) {
    document.getElementById('spar-status').textContent = 'Queue failed (' + r.status + ').';
    btn.disabled = false;
    return;
  }
  const { id } = await r.json();
  document.getElementById('spar-status').textContent = 'Queued #' + id;
  document.getElementById('stream-wrap').classList.remove('hidden');
  document.getElementById('result-host').innerHTML = '';
  document.getElementById('stream-host').innerHTML = '<div class="placeholder">Waiting for worker…</div>';
  document.getElementById('stream-state').innerHTML = '';
  pollExhibition(id);
});

let attachedWorkerId = null;
async function pollExhibition(id) {
  const tick = async () => {
    const r = await fetch('/api/exhibition/' + id);
    if (!r.ok) return;
    const ex = await r.json();
    if (ex.status === 'pending') {
      document.getElementById('stream-state').textContent = 'Waiting for worker…';
    } else if (ex.status === 'running') {
      document.getElementById('stream-state').innerHTML = '<span class="live-pill-ex">● LIVE</span>';
      if (ex.stream_worker_id && ex.stream_worker_id !== attachedWorkerId) {
        attachedWorkerId = ex.stream_worker_id;
        document.getElementById('stream-host').innerHTML = '<img src="/stream/' + ex.stream_worker_id + '" alt="">';
      }
    } else if (ex.status === 'complete' || ex.status === 'failed') {
      attachedWorkerId = null;
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      renderResult(ex);
      // Refresh fighter stats since records and stamina just changed.
      loadFighters();
      document.getElementById('spar-btn').disabled = false;
      document.getElementById('spar-status').textContent = ex.status === 'complete' ? 'Match #' + id + ' complete.' : 'Match #' + id + ' failed.';
    }
  };
  state.pollTimer = setInterval(tick, 1500);
  tick();
}

function renderResult(ex) {
  const host = document.getElementById('result-host');
  if (ex.status === 'failed') {
    host.innerHTML = '<div class="ex-result"><span style="color:#f85149">Match failed:</span> ' + esc(ex.error || 'unknown') + '</div>';
    document.getElementById('stream-host').innerHTML = '<div class="placeholder">Match failed.</div>';
    return;
  }
  const winnerId = ex.winner_owned_fighter_id;
  const homeWon = winnerId === ex.home_owned_fighter_id;
  const awayWon = winnerId === ex.away_owned_fighter_id;
  const homeName = ex.home_master_name || ex.home_name;
  const awayName = ex.away_master_name || ex.away_name;
  let body;
  if (homeWon) body = '<span class="winner">' + esc(homeName) + '</span> defeated <span class="loser">' + esc(awayName) + '</span>';
  else if (awayWon) body = '<span class="winner">' + esc(awayName) + '</span> defeated <span class="loser">' + esc(homeName) + '</span>';
  else body = '<span class="draw">Draw</span> · ' + esc(homeName) + ' vs ' + esc(awayName);
  const stage = ex.stage_display ? ' · stage ' + esc(ex.stage_display) + (ex.stage_author ? ' (by ' + esc(ex.stage_author) + ')' : '') : '';
  host.innerHTML = '<div class="ex-result">' + body + stage + '</div>';
  document.getElementById('stream-host').innerHTML = '<div class="placeholder">Match complete.</div>';
}

function renderHistory() {
  const host = document.getElementById('history-host');
  if (!state.recent.length) { host.innerHTML = ''; return; }
  const items = state.recent.map((r) => {
    let res = 'F'; let label = 'FAILED';
    if (r.status === 'complete') {
      if (r.winner_owned_fighter_id === r.home_owned_fighter_id) { res = 'W'; label = 'P1 WIN'; }
      else if (r.winner_owned_fighter_id === r.away_owned_fighter_id) { res = 'L'; label = 'P2 WIN'; }
      else { res = 'D'; label = 'DRAW'; }
    } else if (r.status === 'pending' || r.status === 'running') {
      label = r.status.toUpperCase();
    }
    const when = r.finished_at || r.started_at || r.created_at || '';
    return '<div class="ex-history-row">' +
      '<span class="when">' + esc(when.replace('T', ' ').replace('Z', '')) + '</span>' +
      '<span>' + esc(r.home_name) + ' <span style="color:#6e7681">(' + esc(r.home_team_name) + ')</span></span>' +
      '<span class="res ' + res + '" style="text-align:center">' + label + '</span>' +
      '<span style="text-align:right">' + esc(r.away_name) + ' <span style="color:#6e7681">(' + esc(r.away_team_name) + ')</span></span>' +
      '<span class="when" style="text-align:right">#' + r.id + '</span>' +
    '</div>';
  }).join('');
  host.innerHTML = '<h2>Recent exhibitions</h2>' + items;
}

// === Tournament mode ===
const tn = {
  size: 8,
  slots: new Array(8).fill(null),
  activeSlot: 0,
  bucket: 'mine',
  search: '',
  generated: false,
  roundsPerFight: 1,
  stageId: '',  // empty string = random per match
  queuedId: null,
  // Server-side bracket state once queued: per-(round,match_index) entry with
  // home/away/winner/status. Used by the renderer to show live progress.
  liveMatches: null,
  liveStatus: null,        // tournament status: pending/running/complete/...
  liveWinnerName: null,    // champion name when status=complete
  pollTimer: null,
};

function tnPool() {
  if (tn.bucket === 'mine') return state.mine;
  if (tn.bucket === 'others') return state.others;
  return state.market;
}

function tnFilteredPool() {
  const ql = tn.search.trim().toLowerCase();
  const rows = tnPool();
  if (!ql) return rows;
  return rows.filter((r) =>
    (r.display_name || '').toLowerCase().includes(ql) ||
    (r.master_display_name || '').toLowerCase().includes(ql) ||
    (r.team_name || '').toLowerCase().includes(ql) ||
    (r.master_author || '').toLowerCase().includes(ql)
  );
}

function tnRenderCounts() {
  document.getElementById('tn-count-mine').textContent = state.mine.length;
  document.getElementById('tn-count-others').textContent = state.others.length;
  document.getElementById('tn-count-market').textContent = state.market.length;
}

function tnRenderSlots() {
  const host = document.getElementById('tn-slots');
  host.innerHTML = tn.slots.map((s, i) => {
    const active = i === tn.activeSlot ? ' active' : '';
    const empty = s ? '' : ' empty';
    const name = s
      ? esc(s.display_name) + '<span class="tn-slot-meta">· ' + esc(s.master_display_name || '') + ' · ' + esc(s.team_name) + '</span>'
      : 'click to assign';
    const clear = s ? '<span class="tn-slot-clear" data-clear="' + i + '" title="Clear">×</span>' : '<span class="tn-slot-clear" style="visibility:hidden">×</span>';
    return '<div class="tn-slot' + active + empty + '" data-slot="' + i + '">' +
      '<span class="tn-slot-num">' + (i + 1) + '.</span>' +
      '<span class="tn-slot-name">' + name + '</span>' +
      clear +
    '</div>';
  }).join('');
  host.querySelectorAll('.tn-slot').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.clear != null) {
        const idx = Number(e.target.dataset.clear);
        tn.slots[idx] = null;
        tnUpdate();
        return;
      }
      tn.activeSlot = Number(el.dataset.slot);
      tnUpdate();
    });
  });
  const filled = tn.slots.filter(Boolean).length;
  document.getElementById('tn-status').textContent = filled + ' / ' + tn.size + ' slots filled';
  document.getElementById('tn-generate').disabled = filled !== tn.size;
}

function tnRenderList() {
  const list = document.getElementById('tn-list');
  const rows = tnFilteredPool();
  const usedIds = new Set(tn.slots.filter(Boolean).map((s) => s.owned_fighter_id));
  list.innerHTML = rows.length
    ? rows.map((r) => {
        const used = usedIds.has(r.owned_fighter_id);
        const star = r.followed ? '<span style="color:#f0ae3c;margin-right:6px">★</span>' : '';
        const stam = Math.round((r.stamina || 0) * 100);
        const masterRec = (r.master_won != null) ? ' · ' + r.master_won + 'w lifetime' : '';
        const cls = 'ex-item' + (used ? ' selected' : '');
        const usedLabel = used ? ' <span style="color:#6e7681;font-size:10px">(in bracket)</span>' : '';
        return '<div class="' + cls + '" data-id="' + r.owned_fighter_id + '">' +
          '<div>' +
            '<div class="name">' + star + esc(r.display_name) + usedLabel + '</div>' +
            '<div class="meta">' + esc(r.master_display_name || '') + ' · <span style="color:#8b949e">' + esc(r.team_name) + '</span></div>' +
          '</div>' +
          '<div class="stats">' + r.matches_won + 'W ' + r.matches_lost + 'L · ' + stam + '%' + masterRec + '</div>' +
        '</div>';
      }).join('')
    : '<div style="padding:12px;color:#6e7681;text-align:center;font-size:12px">No fighters match.</div>';
  list.querySelectorAll('.ex-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.id);
      const all = [...state.mine, ...state.others, ...state.market];
      const f = all.find((x) => x.owned_fighter_id === id);
      if (!f) return;
      if (tn.slots.some((s, i) => s && s.owned_fighter_id === id && i !== tn.activeSlot)) return;
      tn.slots[tn.activeSlot] = f;
      const next = tn.slots.findIndex((s, i) => !s && i > tn.activeSlot);
      const wrap = next === -1 ? tn.slots.findIndex((s) => !s) : next;
      if (wrap !== -1) tn.activeSlot = wrap;
      tnUpdate();
    });
  });
}

function tnRenderBracket() {
  const wrap = document.getElementById('tn-bracket-wrap');
  if (!tn.generated) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const host = document.getElementById('tn-bracket');
  const rounds = Math.log2(tn.size);
  const roundNames = { 1: 'Final', 2: 'Semifinal', 3: 'Quarterfinal', 4: 'Round of 16', 5: 'Round of 32', 6: 'Round of 64' };
  // Match height has to clear the two fighter rows + padding (≈56px) or the
  // boxes visually overlap. Compact mode for big brackets keeps the page sane.
  const matchH = tn.size >= 32 ? 46 : 60;
  const matchW = tn.size >= 32 ? 170 : 200;
  const matchGap = tn.size >= 32 ? 10 : 16;
  const colGap = 48;
  const firstRoundCount = tn.size / 2;
  const totalH = firstRoundCount * matchH + (firstRoundCount - 1) * matchGap;
  const totalW = (rounds + 1) * matchW + rounds * colGap;
  // Pre-compute every match's pixel position so the SVG and DOM stay aligned.
  const matches = [];
  for (let r = 0; r < rounds; r++) {
    const count = firstRoundCount / Math.pow(2, r);
    const slotH = totalH / count;
    for (let m = 0; m < count; m++) {
      const x = r * (matchW + colGap);
      const y = m * slotH + (slotH - matchH) / 2;
      const f1 = r === 0 ? tn.slots[m * 2] : null;
      const f2 = r === 0 ? tn.slots[m * 2 + 1] : null;
      matches.push({ r, m, x, y, w: matchW, h: matchH, f1, f2 });
    }
  }
  const champX = rounds * (matchW + colGap);
  const champY = (totalH - matchH) / 2;
  matches.push({ r: rounds, m: 0, x: champX, y: champY, w: matchW, h: matchH, champion: true });

  // Round titles row
  let titlesHtml = '<div class="tn-bracket-titles" style="width:' + totalW + 'px">';
  for (let r = 0; r < rounds; r++) {
    const remaining = rounds - r;
    const title = roundNames[remaining] || ('Round ' + (r + 1));
    const left = r === 0 ? 0 : colGap;
    titlesHtml += '<div style="width:' + matchW + 'px;margin-left:' + left + 'px">' + esc(title) + '</div>';
  }
  titlesHtml += '<div style="width:' + matchW + 'px;margin-left:' + colGap + 'px;color:#f0ae3c">Champion</div>';
  titlesHtml += '</div>';

  // SVG connectors: for each pair of matches in a round, draw the C-bracket
  // (right of upper → mid x, mid x down to lower's y, lower's right → mid x)
  // and a horizontal stub from mid y into the next round's match.
  let svg = '<svg class="tn-bracket-svg" width="' + totalW + '" height="' + totalH + '">';
  for (let r = 0; r < rounds; r++) {
    const ms = matches.filter((mm) => mm.r === r);
    for (let i = 0; i < ms.length; i += 2) {
      const upper = ms[i];
      const lower = ms[i + 1];
      const next = matches.find((mm) => mm.r === r + 1 && mm.m === Math.floor(i / 2));
      if (!next) continue;
      if (!lower) {
        // Final round → champion: a single straight line.
        const xRight = upper.x + upper.w;
        const yU = upper.y + upper.h / 2;
        const yNext = next.y + next.h / 2;
        svg += '<path d="M ' + xRight + ' ' + yU + ' L ' + next.x + ' ' + yNext + '"/>';
        continue;
      }
      const xRight = upper.x + upper.w;
      const yU = upper.y + upper.h / 2;
      const yL = lower.y + lower.h / 2;
      const xMid = xRight + colGap / 2;
      const yMid = (yU + yL) / 2;
      const xNext = next.x;
      const yNext = next.y + next.h / 2;
      svg += '<path d="M ' + xRight + ' ' + yU + ' L ' + xMid + ' ' + yU + ' L ' + xMid + ' ' + yL + ' L ' + xRight + ' ' + yL + '"/>';
      svg += '<path d="M ' + xMid + ' ' + yMid + ' L ' + xNext + ' ' + yNext + '"/>';
    }
  }
  svg += '</svg>';

  // Match boxes — when queued, the live data overlays the static slot info
  // so the bracket reflects in-flight winners and current match.
  const liveByKey = new Map();
  if (tn.liveMatches) for (const lm of tn.liveMatches) liveByKey.set(lm.round + ':' + lm.match_index, lm);

  let boxes = '';
  for (const mm of matches) {
    const style = 'left:' + mm.x + 'px;top:' + mm.y + 'px;width:' + mm.w + 'px;height:' + mm.h + 'px';
    if (mm.champion) {
      const champLabel = tn.liveWinnerName ? '🏆 ' + esc(tn.liveWinnerName) : '🏆 Champion: TBD';
      const champCls = tn.liveWinnerName ? 'tn-fighter' : 'tn-fighter tbd';
      boxes += '<div class="tn-match tn-champion" style="' + style + '"><div class="' + champCls + '" style="text-align:center">' + champLabel + '</div></div>';
      continue;
    }
    const live = liveByKey.get(mm.r + ':' + mm.m);
    let f1Name, f2Name, f1Id, f2Id, mStatus;
    if (live) {
      f1Name = live.home_name;
      f2Name = live.away_name;
      f1Id = live.home_owned_fighter_id;
      f2Id = live.away_owned_fighter_id;
      mStatus = live.status;
    } else {
      f1Name = mm.f1?.display_name;
      f2Name = mm.f2?.display_name;
      f1Id = mm.f1?.owned_fighter_id;
      f2Id = mm.f2?.owned_fighter_id;
      mStatus = 'pending';
    }
    const winnerId = live?.winner_owned_fighter_id;
    const f1Won = winnerId && f1Id === winnerId;
    const f2Won = winnerId && f2Id === winnerId;
    const f1Lost = winnerId && f1Id && f1Id !== winnerId;
    const f2Lost = winnerId && f2Id && f2Id !== winnerId;
    const coinflip = !!live?.was_coinflip;
    const crashFlip = !!live?.was_crash;
    const coinIcon = coinflip
      ? ' <span class="tn-coinflip" title="' + (crashFlip ? 'Match crashed' : 'Match ended in a draw') + ' — winner picked by coin flip">🪙</span>'
      : '';
    const cell = (name, seed, won, lost) => {
      if (!name) return '<div class="tn-fighter tbd"><span class="seed"></span>TBD</div>';
      const cls = 'tn-fighter' + (won ? ' winner' : '') + (lost ? ' loser' : '');
      const flag = won && coinflip ? coinIcon : '';
      return '<div class="' + cls + '"><span class="seed">' + (seed ? '#' + seed : '') + '</span>' + esc(name) + flag + '</div>';
    };
    const s1 = mm.r === 0 ? mm.m * 2 + 1 : '';
    const s2 = mm.r === 0 ? mm.m * 2 + 2 : '';
    const matchCls = 'tn-match' + (mStatus === 'running' ? ' tn-running' : '') + (mStatus === 'complete' ? ' tn-done' : '');
    boxes += '<div class="' + matchCls + '" style="' + style + '">' + cell(f1Name, s1, f1Won, f1Lost) + cell(f2Name, s2, f2Won, f2Lost) + '</div>';
  }

  host.style.width = totalW + 'px';
  host.style.height = totalH + 'px';
  host.innerHTML = svg + boxes;
  // Render titles outside the bracket box.
  let titleHost = document.getElementById('tn-bracket-titles-host');
  if (!titleHost) {
    titleHost = document.createElement('div');
    titleHost.id = 'tn-bracket-titles-host';
    host.parentNode.insertBefore(titleHost, host);
  }
  titleHost.innerHTML = titlesHtml;
  // Bracket meta line
  document.getElementById('tn-bracket-meta').textContent =
    ' · ' + tn.size + ' fighters · best of ' + tn.roundsPerFight + ' round' + (tn.roundsPerFight > 1 ? 's' : '') + ' per match';
}

function tnUpdate() {
  tnRenderSlots();
  tnRenderList();
  tnRenderCounts();
  if (tn.generated) tnRenderBracket();
}

function tnSetSize(n) {
  tn.size = n;
  tn.slots = new Array(n).fill(null);
  tn.activeSlot = 0;
  tn.generated = false;
  document.querySelectorAll('#tn-size button').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === n));
  document.getElementById('tn-bracket-wrap').classList.add('hidden');
  tnUpdate();
}

function tnFillFrom(rows, sortFn) {
  const pool = sortFn ? [...rows].sort(sortFn) : [...rows];
  const usedIds = new Set();
  for (let i = 0; i < tn.slots.length; i++) {
    if (tn.slots[i]) usedIds.add(tn.slots[i].owned_fighter_id);
  }
  for (let i = 0; i < tn.slots.length; i++) {
    if (tn.slots[i]) continue;
    const next = pool.find((r) => !usedIds.has(r.owned_fighter_id));
    if (!next) break;
    tn.slots[i] = next;
    usedIds.add(next.owned_fighter_id);
  }
  tn.generated = false;
  document.getElementById('tn-bracket-wrap').classList.add('hidden');
  tnUpdate();
}

function tnInit() {
  document.querySelectorAll('#mode-tabs .mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#mode-tabs .mode-tab').forEach((t) => t.classList.toggle('active', t === tab));
      const mode = tab.dataset.mode;
      document.getElementById('match-mode').hidden = mode !== 'match';
      document.getElementById('tournament-mode').hidden = mode !== 'tournament';
      if (mode === 'tournament') tnUpdate();
    });
  });
  document.querySelectorAll('#tn-size button').forEach((b) => {
    b.addEventListener('click', () => tnSetSize(Number(b.dataset.size)));
  });
  document.getElementById('tn-rpf').addEventListener('change', (e) => {
    tn.roundsPerFight = Number(e.target.value);
    if (tn.generated) tnRenderBracket();
  });
  document.getElementById('tn-stage').addEventListener('change', (e) => {
    tn.stageId = e.target.value;
    if (tn.generated) tnRenderBracket();
  });
  document.querySelectorAll('.ex-tabs[data-side="tn"] .ex-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      tn.bucket = tab.dataset.bucket;
      document.querySelectorAll('.ex-tabs[data-side="tn"] .ex-tab').forEach((t) => t.classList.toggle('active', t === tab));
      tnRenderList();
    });
  });
  document.getElementById('tn-search').addEventListener('input', (e) => {
    tn.search = e.target.value;
    tnRenderList();
  });
  document.getElementById('tn-fill-mine').addEventListener('click', () => tnFillFrom(state.mine));
  document.getElementById('tn-fill-random').addEventListener('click', () => {
    const all = [...state.mine, ...state.others];
    tnFillFrom(all, () => Math.random() - 0.5);
  });
  document.getElementById('tn-fill-wins').addEventListener('click', () => {
    const all = [...state.mine, ...state.others];
    tnFillFrom(all, (a, b) => (b.master_won || 0) - (a.master_won || 0));
  });
  document.getElementById('tn-shuffle').addEventListener('click', () => {
    // Fisher-Yates on the filled slots only; preserves null gaps so a
    // partially-filled bracket can still be re-shuffled.
    const filled = tn.slots.filter(Boolean);
    for (let i = filled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [filled[i], filled[j]] = [filled[j], filled[i]];
    }
    let k = 0;
    tn.slots = tn.slots.map((s) => s ? filled[k++] : null);
    tn.generated = false;
    document.getElementById('tn-bracket-wrap').classList.add('hidden');
    tnUpdate();
  });
  document.getElementById('tn-clear').addEventListener('click', () => {
    tn.slots = new Array(tn.size).fill(null);
    tn.activeSlot = 0;
    tn.generated = false;
    document.getElementById('tn-bracket-wrap').classList.add('hidden');
    tnUpdate();
  });
  document.getElementById('tn-generate').addEventListener('click', () => {
    if (tn.slots.filter(Boolean).length !== tn.size) return;
    tn.generated = true;
    tn.queuedId = null;
    tnRenderBracket();
    tnRenderConfirmBar();
  });
  document.getElementById('tn-start-btn').addEventListener('click', tnStartHandler);
}

let tnConfirmArmed = false;
function tnRenderConfirmBar() {
  const bar = document.getElementById('tn-confirm-bar');
  // Lock the upper builder controls + picker while a tournament is queued so
  // editing slots can't drift out of sync with the persisted bracket.
  document.getElementById('tournament-mode').classList.toggle('locked', !!tn.queuedId);
  if (!tn.generated) { bar.innerHTML = ''; return; }
  if (tn.queuedId) {
    bar.classList.add('queued');
    let bannerHtml;
    let actionHtml;
    if (tn.liveStatus === 'complete') {
      bannerHtml = '<div class="tn-queued-banner" style="border-color:#3fb950;background:#3fb95022">Tournament <b>#' + tn.queuedId + '</b> complete — champion: ' + esc(tn.liveWinnerName || '?') + '</div>';
      actionHtml = '<button class="ex-btn" id="tn-new-btn">New tournament</button>';
    } else if (tn.liveStatus === 'cancelled') {
      bannerHtml = '<div class="tn-queued-banner" style="border-color:#6e7681">Tournament <b>#' + tn.queuedId + '</b> cancelled.</div>';
      actionHtml = '<button class="ex-btn" id="tn-new-btn">New tournament</button>';
    } else if (tn.liveStatus === 'running') {
      bannerHtml = '<div class="tn-queued-banner" style="border-color:#da3633">Tournament <b>#' + tn.queuedId + '</b> running. Watch the bracket fill in below.</div>';
      actionHtml = '';
    } else {
      bannerHtml = '<div class="tn-queued-banner">Tournament <b>#' + tn.queuedId + '</b> queued. Waiting for an exhibition worker to pick up the first match…</div>';
      actionHtml = '<button class="ex-btn danger" id="tn-cancel-tourn-btn">Cancel tournament</button>';
    }
    bar.innerHTML = bannerHtml + actionHtml;
    const cancelBtn = document.getElementById('tn-cancel-tourn-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', tnCancelHandler);
    const newBtn = document.getElementById('tn-new-btn');
    if (newBtn) newBtn.addEventListener('click', tnResetForNew);
    return;
  }
  bar.classList.remove('queued');
  if (!tnConfirmArmed) {
    bar.innerHTML = '<button class="ex-btn" id="tn-start-btn">Confirm and start tournament</button>' +
      '<span class="tn-status" id="tn-confirm-status"></span>';
  } else {
    bar.innerHTML = '<span style="color:#c9d1d9;font-size:13px">Start ' + tn.size + '-fighter bracket, best of ' + tn.roundsPerFight + ' round' + (tn.roundsPerFight > 1 ? 's' : '') + '?</span>' +
      '<button class="ex-btn" id="tn-start-btn">Yes, start</button>' +
      '<button class="ex-btn danger" id="tn-cancel-btn">Cancel</button>';
    document.getElementById('tn-cancel-btn').addEventListener('click', () => {
      tnConfirmArmed = false;
      tnRenderConfirmBar();
    });
  }
  document.getElementById('tn-start-btn').addEventListener('click', tnStartHandler);
}

async function tnStartHandler() {
  if (!tnConfirmArmed) {
    tnConfirmArmed = true;
    tnRenderConfirmBar();
    return;
  }
  const btn = document.getElementById('tn-start-btn');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    const r = await fetch('/api/exhibition/tournament', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: tn.size,
        rounds_per_fight: tn.roundsPerFight,
        slot_ids: tn.slots.map((s) => s.owned_fighter_id),
        stage_id: tn.stageId || null,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      // Server says they already have one running — hydrate to that view
      // instead of showing an error so the UI stays in sync with the DB.
      if (err.error === 'tournament_in_progress' && err.existing_id) {
        tn.queuedId = err.existing_id;
        tnConfirmArmed = false;
        tnRenderConfirmBar();
        return;
      }
      btn.disabled = false;
      btn.textContent = 'Yes, start';
      const status = document.getElementById('tn-confirm-status');
      if (status) status.textContent = 'Failed: ' + (err.error || r.status);
      else alert('Failed: ' + (err.error || r.status));
      return;
    }
    const { id } = await r.json();
    tn.queuedId = id;
    tnConfirmArmed = false;
    tnRenderConfirmBar();
    tnStartPolling();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Yes, start';
    alert('Network error: ' + err.message);
  }
}

function tnResetForNew() {
  tnStopPolling();
  tn.queuedId = null;
  tn.generated = false;
  tn.slots = new Array(tn.size).fill(null);
  tn.activeSlot = 0;
  tn.liveMatches = null;
  tn.liveStatus = null;
  tn.liveWinnerName = null;
  document.getElementById('tn-bracket-wrap').classList.add('hidden');
  tnUpdate();
  tnRenderConfirmBar();
}

function tnStopPolling() {
  if (tn.pollTimer) { clearInterval(tn.pollTimer); tn.pollTimer = null; }
}

let tnAttachedWorkerId = null;
async function tnPollOnce() {
  if (!tn.queuedId) return;
  try {
    const r = await fetch('/api/exhibition/tournament/' + tn.queuedId);
    if (!r.ok) return;
    const t = await r.json();
    tn.liveMatches = t.matches || [];
    tn.liveStatus = t.status;
    if (t.status === 'complete' && t.winner_owned_fighter_id) {
      const win = tn.liveMatches.find((m) => m.winner_owned_fighter_id === t.winner_owned_fighter_id);
      tn.liveWinnerName = win?.winner_name || null;
    } else {
      tn.liveWinnerName = null;
    }
    tnRenderBracket();
    tnRenderConfirmBar();
    // Manage the live stream embed. Re-attach only when worker changes so
    // we don't tear down the MJPEG <img> on every poll tick.
    const wrap = document.getElementById('tn-stream-wrap');
    const host = document.getElementById('tn-stream-host');
    const title = document.getElementById('tn-stream-title');
    if (t.stream_worker_id) {
      const running = tn.liveMatches.find((m) => m.id === t.running_match_id);
      const label = running && running.home_name && running.away_name
        ? running.home_name + ' vs ' + running.away_name
        : 'Live match';
      title.textContent = label;
      wrap.classList.remove('hidden');
      if (t.stream_worker_id !== tnAttachedWorkerId) {
        tnAttachedWorkerId = t.stream_worker_id;
        host.innerHTML = '<img src="/stream/' + t.stream_worker_id + '" alt="">';
      }
    } else {
      tnAttachedWorkerId = null;
      wrap.classList.add('hidden');
      host.innerHTML = '<div class="placeholder">Waiting for stream…</div>';
    }
    if (t.status === 'complete' || t.status === 'cancelled' || t.status === 'failed') {
      tnStopPolling();
    }
  } catch {}
}

function tnStartPolling() {
  tnStopPolling();
  tnPollOnce();
  tn.pollTimer = setInterval(tnPollOnce, 2500);
}

async function tnCancelHandler() {
  if (!tn.queuedId) return;
  if (!confirm('Cancel tournament #' + tn.queuedId + '? This can only be done while it is still pending.')) return;
  const btn = document.getElementById('tn-cancel-tourn-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
  try {
    const r = await fetch('/api/exhibition/tournament/' + tn.queuedId + '/cancel', { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Cancel failed: ' + (err.error || r.status));
      if (btn) { btn.disabled = false; btn.textContent = 'Cancel tournament'; }
      return;
    }
    tnStopPolling();
    tn.queuedId = null;
    tn.generated = false;
    tn.slots = new Array(tn.size).fill(null);
    tn.activeSlot = 0;
    tn.liveMatches = null;
    tn.liveStatus = null;
    tn.liveWinnerName = null;
    document.getElementById('tn-bracket-wrap').classList.add('hidden');
    tnUpdate();
    tnRenderConfirmBar();
  } catch (err) {
    alert('Network error: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel tournament'; }
  }
}

tnInit();
loadFighters();
</script>
</body></html>`;

const TOURNAMENTS_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Tournaments · MugenBattle</title>
<style>${COMMON_CSS}
  .tt-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; margin-bottom: 14px; }
  .tt-hdr { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
  .tt-hdr .tt-id { font-size: 14px; font-weight: 600; color: #c9d1d9; }
  .tt-hdr .tt-meta { color: #8b949e; font-size: 12px; }
  .tt-hdr .tt-pill { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 7px; border-radius: 999px; font-weight: 600; }
  .tt-hdr .tt-pill.running { background: #da363322; color: #f85149; border: 1px solid #f85149; }
  .tt-hdr .tt-pill.queued { background: #30363d; color: #8b949e; }
  .tt-hdr .tt-progress { margin-left: auto; font-size: 12px; color: #8b949e; font-variant-numeric: tabular-nums; }
  .tt-stream { background: #161b22; border-radius: 8px; margin-bottom: 12px; }
  .tt-stream .ex-stream { aspect-ratio: 4 / 3; max-width: 600px; margin: 0 auto; }
  .tt-stream .ex-stream img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; display: block; }
  .tt-stream .placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: #6e7681; font-size: 14px; }
  .tt-stream-hdr { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; }
  .tt-stream-hdr h3 { margin: 0; font-size: 12px; color: #c9d1d9; font-weight: 600; }
  .tt-empty { padding: 16px; color: #6e7681; text-align: center; font-size: 13px; }
  .tt-queue-row { display: grid; grid-template-columns: 40px 80px 1fr auto; gap: 12px; align-items: center; padding: 10px 14px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 6px; font-size: 13px; }
  .tt-queue-row .pos { color: #8b949e; font-variant-numeric: tabular-nums; font-weight: 600; }
  .tt-queue-row .id { color: #c9d1d9; font-weight: 600; }
  .tt-queue-row .meta { color: #8b949e; font-size: 12px; }
  .tt-queue-row .when { color: #6e7681; font-size: 11px; text-align: right; }
  .live-pill-ex { display: inline-block; padding: 2px 8px; background: #da3633; color: #fff; border-radius: 999px; font-size: 11px; font-weight: 600; animation: live-pulse 1.6s infinite; }
  @keyframes live-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
  /* Bracket — same renderer as the /exhibition tournament tab */
  .tn-bracket-scroll { overflow-x: auto; padding-bottom: 8px; }
  .tn-bracket-titles { display: flex; }
  .tn-bracket-titles > div { font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.4px; text-align: center; margin-bottom: 8px; }
  .tn-bracket { position: relative; }
  .tn-bracket .tn-match { position: absolute; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; font-size: 12px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; }
  .tn-bracket .tn-match.tn-champion { border-color: #f0ae3c; background: #1d232b; }
  .tn-bracket .tn-match.tn-running { border-color: #da3633; box-shadow: 0 0 0 2px rgba(218,54,51,0.25); animation: tn-running-pulse 1.6s infinite; }
  .tn-bracket .tn-match.tn-done { border-color: #21262d; }
  .tn-bracket .tn-match .tn-fighter { padding: 3px 0; color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
  .tn-bracket .tn-match .tn-fighter.tbd { color: #6e7681; font-style: italic; }
  .tn-bracket .tn-match .tn-fighter.winner { color: #3fb950; font-weight: 600; }
  .tn-bracket .tn-match .tn-fighter.loser { color: #6e7681; text-decoration: line-through; }
  .tn-bracket .tn-match .tn-fighter .seed { color: #6e7681; font-size: 10px; margin-right: 6px; font-variant-numeric: tabular-nums; display: inline-block; min-width: 18px; }
  .tn-bracket-svg { position: absolute; top: 0; left: 0; pointer-events: none; }
  .tn-bracket-svg path { stroke: #30363d; stroke-width: 1.5; fill: none; }
  @keyframes tn-running-pulse { 0%,100% { box-shadow: 0 0 0 2px rgba(218,54,51,0.25); } 50% { box-shadow: 0 0 0 3px rgba(218,54,51,0.5); } }
  .tn-bracket .tn-coinflip { cursor: help; font-size: 11px; opacity: 0.85; }
</style></head>
<body>
<h1>🏆 Tournaments</h1>
<nav>
  <a href="/">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market">Market</a>
  <a href="/exhibition">Exhibition</a>
  <a href="/trades">Trades</a>
  <a href="/tournaments" class="active">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>

<div class="panel" style="margin-bottom: 16px">
  <p style="margin:0;font-size:13px;color:#8b949e">Live brackets and the queue. <span id="cap-line"></span> Each user can have one active tournament — others wait in queue. Drawn matches are tiebroken by coin flip (🪙).</p>
</div>

<h2 style="font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:#8b949e;margin:0 0 8px">Active</h2>
<div id="active-host"></div>
<h2 id="queue-hdr" style="font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:#8b949e;margin:18px 0 8px;display:none">Queue</h2>
<div id="queue-host"></div>
<h2 id="recent-hdr" style="font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:#8b949e;margin:18px 0 8px;display:none">Recent champions</h2>
<div id="recent-host"></div>

<script>
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

// Track which worker each card's MJPEG is attached to so we don't tear
// down the <img> on every refresh tick (browser would reset the stream).
const attachedStreams = {};

function renderBracketInto(t, hostId) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const rounds = Math.log2(t.size);
  // Match height has to clear two fighter rows + padding — same dims as
  // /exhibition's renderer or the boxes start visually overlapping.
  const matchH = t.size >= 32 ? 46 : 60;
  const matchW = t.size >= 32 ? 170 : 200;
  const matchGap = t.size >= 32 ? 10 : 16;
  const colGap = 48;
  const firstRoundCount = t.size / 2;
  const totalH = firstRoundCount * matchH + (firstRoundCount - 1) * matchGap;
  const totalW = (rounds + 1) * matchW + rounds * colGap;
  const matchByKey = new Map();
  for (const m of t.matches) matchByKey.set(m.round + ':' + m.match_index, m);
  const slots = [];
  for (let r = 0; r < rounds; r++) {
    const count = firstRoundCount / Math.pow(2, r);
    const slotH = totalH / count;
    for (let m = 0; m < count; m++) {
      const x = r * (matchW + colGap);
      const y = m * slotH + (slotH - matchH) / 2;
      slots.push({ r, m, x, y, w: matchW, h: matchH, live: matchByKey.get(r + ':' + m) });
    }
  }
  const champX = rounds * (matchW + colGap);
  const champY = (totalH - matchH) / 2;
  // Round titles
  const roundNames = { 1: 'Final', 2: 'Semifinal', 3: 'Quarterfinal', 4: 'Round of 16', 5: 'Round of 32', 6: 'Round of 64' };
  let titlesHtml = '<div class="tn-bracket-titles" style="width:' + totalW + 'px">';
  for (let r = 0; r < rounds; r++) {
    const remaining = rounds - r;
    const title = roundNames[remaining] || ('Round ' + (r + 1));
    const left = r === 0 ? 0 : colGap;
    titlesHtml += '<div style="width:' + matchW + 'px;margin-left:' + left + 'px">' + esc(title) + '</div>';
  }
  titlesHtml += '<div style="width:' + matchW + 'px;margin-left:' + colGap + 'px;color:#f0ae3c">Champion</div>';
  titlesHtml += '</div>';
  // SVG connectors
  let svg = '<svg class="tn-bracket-svg" width="' + totalW + '" height="' + totalH + '">';
  for (let r = 0; r < rounds; r++) {
    const ms = slots.filter((s) => s.r === r);
    for (let i = 0; i < ms.length; i += 2) {
      const upper = ms[i]; const lower = ms[i + 1];
      const next = slots.find((s) => s.r === r + 1 && s.m === Math.floor(i / 2));
      const xRight = upper.x + upper.w;
      const yU = upper.y + upper.h / 2;
      if (!lower) {
        if (!next) {
          // Final → champion stub
          svg += '<path d="M ' + xRight + ' ' + yU + ' L ' + champX + ' ' + (champY + matchH / 2) + '"/>';
        } else {
          svg += '<path d="M ' + xRight + ' ' + yU + ' L ' + next.x + ' ' + (next.y + next.h / 2) + '"/>';
        }
        continue;
      }
      if (!next) continue;
      const yL = lower.y + lower.h / 2;
      const xMid = xRight + colGap / 2;
      const yMid = (yU + yL) / 2;
      const xNext = next.x;
      const yNext = next.y + next.h / 2;
      svg += '<path d="M ' + xRight + ' ' + yU + ' L ' + xMid + ' ' + yU + ' L ' + xMid + ' ' + yL + ' L ' + xRight + ' ' + yL + '"/>';
      svg += '<path d="M ' + xMid + ' ' + yMid + ' L ' + xNext + ' ' + yNext + '"/>';
    }
  }
  // Connector from final to champion (for sizes >= 4 where there's a round before champ)
  const finalSlot = slots.find((s) => s.r === rounds - 1);
  if (finalSlot) {
    svg += '<path d="M ' + (finalSlot.x + finalSlot.w) + ' ' + (finalSlot.y + finalSlot.h / 2) + ' L ' + champX + ' ' + (champY + matchH / 2) + '"/>';
  }
  svg += '</svg>';
  // Match boxes
  let boxes = '';
  for (const s of slots) {
    const style = 'left:' + s.x + 'px;top:' + s.y + 'px;width:' + s.w + 'px;height:' + s.h + 'px';
    const live = s.live;
    const f1Name = live?.home_name;
    const f2Name = live?.away_name;
    const f1Id = live?.home_owned_fighter_id;
    const f2Id = live?.away_owned_fighter_id;
    const winnerId = live?.winner_owned_fighter_id;
    const status = live?.status || 'pending';
    const f1Won = winnerId && f1Id === winnerId;
    const f2Won = winnerId && f2Id === winnerId;
    const f1Lost = winnerId && f1Id && f1Id !== winnerId;
    const f2Lost = winnerId && f2Id && f2Id !== winnerId;
    const coinflip = !!live?.was_coinflip;
    const crashFlip = !!live?.was_crash;
    const coinIcon = coinflip
      ? ' <span class="tn-coinflip" title="' + (crashFlip ? 'Match crashed' : 'Match ended in a draw') + ' — winner picked by coin flip">🪙</span>'
      : '';
    const cell = (name, seed, won, lost) => {
      if (!name) return '<div class="tn-fighter tbd"><span class="seed"></span>TBD</div>';
      const cls = 'tn-fighter' + (won ? ' winner' : '') + (lost ? ' loser' : '');
      const flag = won && coinflip ? coinIcon : '';
      return '<div class="' + cls + '"><span class="seed">' + (seed ? '#' + seed : '') + '</span>' + esc(name) + flag + '</div>';
    };
    const s1 = s.r === 0 ? s.m * 2 + 1 : '';
    const s2 = s.r === 0 ? s.m * 2 + 2 : '';
    const matchCls = 'tn-match' + (status === 'running' ? ' tn-running' : '') + (status === 'complete' ? ' tn-done' : '');
    boxes += '<div class="' + matchCls + '" style="' + style + '">' + cell(f1Name, s1, f1Won, f1Lost) + cell(f2Name, s2, f2Won, f2Lost) + '</div>';
  }
  // Champion box
  const champStyle = 'left:' + champX + 'px;top:' + champY + 'px;width:' + matchW + 'px;height:' + matchH + 'px';
  let champHtml;
  if (t.status === 'complete' && t.winner_owned_fighter_id) {
    const win = t.matches.find((m) => m.winner_owned_fighter_id === t.winner_owned_fighter_id);
    champHtml = '<div class="tn-match tn-champion" style="' + champStyle + '"><div class="tn-fighter" style="text-align:center">🏆 ' + esc(win?.winner_name || '?') + '</div></div>';
  } else {
    champHtml = '<div class="tn-match tn-champion" style="' + champStyle + '"><div class="tn-fighter tbd" style="text-align:center">🏆 Champion: TBD</div></div>';
  }
  host.style.width = totalW + 'px';
  host.style.height = totalH + 'px';
  host.innerHTML = svg + boxes + champHtml;
  // Inject titles row above the bracket (host's parent .tn-bracket-scroll)
  const scrollEl = host.parentNode;
  let titleRow = scrollEl.previousElementSibling;
  if (!titleRow || !titleRow.classList.contains('tn-bracket-titles-host')) {
    titleRow = document.createElement('div');
    titleRow.className = 'tn-bracket-titles-host';
    scrollEl.parentNode.insertBefore(titleRow, scrollEl);
  }
  titleRow.innerHTML = titlesHtml;
}

function renderTournamentCard(t) {
  const totalRounds = Math.log2(t.size);
  const matchesDone = t.matches.filter((m) => m.status === 'complete').length;
  const total = t.matches.length;
  const stream = t.stream_worker_id
    ? '<div class="tt-stream"><div class="tt-stream-hdr"><h3>Live match</h3><span class="live-pill-ex">● LIVE</span></div><div class="ex-stream" id="stream-' + t.id + '"><div class="placeholder">Connecting…</div></div></div>'
    : '';
  const userTag = t.requester_is_bot
    ? '<span style="color:#8b949e">' + esc(t.requester_username || '?') + ' <span style="font-size:9px;background:#21262d;padding:1px 4px;border-radius:3px">BOT</span></span>'
    : '<span style="color:#58a6ff">@' + esc(t.requester_username || '?') + '</span>';
  return '<div class="tt-card">' +
    '<div class="tt-hdr">' +
      '<span class="tt-id">#' + t.id + '</span>' +
      '<span class="tt-pill running">running</span>' +
      '<span class="tt-meta">by ' + userTag + ' · ' + t.size + ' fighters · best of ' + t.rounds_per_fight + '</span>' +
      '<span class="tt-progress" id="progress-' + t.id + '">' + matchesDone + ' / ' + total + ' matches done</span>' +
    '</div>' +
    stream +
    '<div class="tn-bracket-scroll"><div class="tn-bracket" id="bracket-' + t.id + '"></div></div>' +
  '</div>';
}

async function refresh() {
  let r;
  try { r = await fetch('/api/tournaments'); }
  catch { return; }
  if (!r.ok) return;
  const { tournaments, recent, max_concurrent } = await r.json();
  document.getElementById('cap-line').textContent = 'Up to ' + max_concurrent + ' tournament' + (max_concurrent === 1 ? '' : 's') + ' run concurrently;';
  const running = tournaments.filter((t) => t.status === 'running');
  const queued = tournaments.filter((t) => t.status === 'pending');

  const activeHost = document.getElementById('active-host');
  if (running.length === 0) {
    activeHost.innerHTML = '<div class="tt-empty">No tournaments running.</div>';
    Object.keys(attachedStreams).forEach((k) => delete attachedStreams[k]);
  } else {
    // Detect added/removed cards. If the set of IDs changed, re-render the
    // cards and clear stream attachments so the renderer rebuilds. Otherwise
    // render brackets in-place (and only re-attach streams when worker changes).
    const existing = new Set(Array.from(activeHost.querySelectorAll('.tt-card .tt-id')).map((el) => Number(el.textContent.replace('#', ''))));
    const wanted = new Set(running.map((t) => t.id));
    const sameSet = existing.size === wanted.size && [...existing].every((id) => wanted.has(id));
    if (!sameSet) {
      activeHost.innerHTML = running.map(renderTournamentCard).join('');
      Object.keys(attachedStreams).forEach((k) => delete attachedStreams[k]);
    }
    for (const t of running) {
      renderBracketInto(t, 'bracket-' + t.id);
      // Update the in-card progress text in place so it stays fresh across
      // refreshes even when the card itself isn't rebuilt.
      const progEl = document.getElementById('progress-' + t.id);
      if (progEl) {
        const done = t.matches.filter((m) => m.status === 'complete').length;
        progEl.textContent = done + ' / ' + t.matches.length + ' matches done';
      }
      if (t.stream_worker_id) {
        const host = document.getElementById('stream-' + t.id);
        if (host && attachedStreams[t.id] !== t.stream_worker_id) {
          attachedStreams[t.id] = t.stream_worker_id;
          host.innerHTML = '<img src="/stream/' + t.stream_worker_id + '" alt="">';
        }
      } else if (attachedStreams[t.id]) {
        delete attachedStreams[t.id];
        const host = document.getElementById('stream-' + t.id);
        if (host) host.innerHTML = '<div class="placeholder">Match transitioning…</div>';
      }
    }
  }

  // Recent champions — clickable cards that expand into the full bracket.
  const recentList = recent || [];
  document.getElementById('recent-hdr').style.display = recentList.length ? '' : 'none';
  const recentHost = document.getElementById('recent-host');
  // Preserve which recent cards were expanded across refreshes.
  const expanded = new Set(Array.from(recentHost.querySelectorAll('.tt-card[data-expanded="1"]')).map((el) => Number(el.dataset.id)));
  recentHost.innerHTML = recentList.map((t) => {
    const userTag = t.requester_is_bot
      ? '<span style="color:#8b949e">' + esc(t.requester_username || '?') + '</span>'
      : '<span style="color:#58a6ff">@' + esc(t.requester_username || '?') + '</span>';
    const champMatch = t.matches.find((m) => m.winner_owned_fighter_id === t.winner_owned_fighter_id);
    const champ = champMatch?.winner_name || '?';
    const isExpanded = expanded.has(t.id);
    return '<div class="tt-card" data-id="' + t.id + '" data-expanded="' + (isExpanded ? '1' : '0') + '">' +
      '<div class="tt-hdr" style="cursor:pointer" data-toggle="' + t.id + '">' +
        '<span class="tt-id">#' + t.id + '</span>' +
        '<span class="tt-pill" style="background:#3fb95022;color:#3fb950;border:1px solid #3fb950">complete</span>' +
        '<span class="tt-meta">by ' + userTag + ' · ' + t.size + ' fighters · best of ' + t.rounds_per_fight + '</span>' +
        '<span class="tt-progress">🏆 ' + esc(champ) + '</span>' +
        '<span style="color:#6e7681;font-size:10px;margin-left:8px">' + (isExpanded ? '▾' : '▸') + '</span>' +
      '</div>' +
      (isExpanded ? '<div class="tn-bracket-scroll"><div class="tn-bracket" id="recent-bracket-' + t.id + '"></div></div>' : '') +
    '</div>';
  }).join('');
  recentHost.querySelectorAll('[data-toggle]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.toggle);
      const card = el.closest('.tt-card');
      const willExpand = card.dataset.expanded !== '1';
      card.dataset.expanded = willExpand ? '1' : '0';
      // Re-trigger refresh to render bracket into the now-expanded card
      refresh();
    });
  });
  for (const t of recentList) {
    if (expanded.has(t.id)) renderBracketInto(t, 'recent-bracket-' + t.id);
  }

  document.getElementById('queue-hdr').style.display = queued.length ? '' : 'none';
  document.getElementById('queue-host').innerHTML = queued.map((t, i) => {
    const userTag = t.requester_is_bot
      ? esc(t.requester_username) + ' <span style="font-size:9px;background:#21262d;padding:1px 4px;border-radius:3px;color:#8b949e">BOT</span>'
      : '<span style="color:#58a6ff">@' + esc(t.requester_username) + '</span>';
    return '<div class="tt-queue-row">' +
      '<span class="pos">' + (i + 1) + '</span>' +
      '<span class="id">#' + t.id + '</span>' +
      '<span class="meta">by ' + userTag + ' · ' + t.size + ' fighters · best of ' + t.rounds_per_fight + '</span>' +
      '<span class="when">' + esc(t.created_at) + '</span>' +
    '</div>';
  }).join('');
}

refresh();
setInterval(refresh, 3000);
</script>
</body></html>`;

const PYRAMID_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Pyramid · MugenBattle</title>
<style>${COMMON_CSS}
  .tier { margin-bottom: 18px; }
  .tier .hdr { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
  .tier .hdr .tname { font-size: 13px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.4px; }
  .tier .hdr .tier-n { font-size: 20px; font-weight: 600; color: #c9d1d9; font-variant-numeric: tabular-nums; }
  .tier.t1 .hdr .tier-n { color: #f0ae3c; }
  .tier .rows { display: grid; gap: 4px; }
  .prow { display: grid; grid-template-columns: 30px 2.4fr 50px 50px 50px 70px 60px; gap: 8px; padding: 8px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; align-items: center; font-size: 13px; font-variant-numeric: tabular-nums; position: relative; }
  .prow.champion { border-left: 3px solid #ffd700; background: linear-gradient(90deg, rgba(255,215,0,0.14) 0%, #161b22 45%); }
  .prow.champion .pos { color: #ffd700; font-weight: 700; }
  .prow.promote { border-left: 3px solid #3fb950; background: linear-gradient(90deg, rgba(63,185,80,0.10) 0%, #161b22 40%); }
  .prow.relegate { border-left: 3px solid #f85149; background: linear-gradient(90deg, rgba(248,81,73,0.10) 0%, #161b22 40%); }
  .prow.drop { border-left: 3px solid #f0ae3c; background: linear-gradient(90deg, rgba(240,174,60,0.12) 0%, #161b22 40%); }
  .prow.mine { border-color: #58a6ff; background: #1d2a3e; }
  .prow .zone-tag { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; padding: 2px 6px; border-radius: 4px; opacity: 0; pointer-events: none; }
  .prow.promote .zone-tag { opacity: 0; }
  .zone-key { display: flex; gap: 14px; padding: 10px 14px; background: #0d1117; border-radius: 8px; margin-bottom: 10px; font-size: 11px; }
  .zone-key .k { display: flex; align-items: center; gap: 6px; color: #8b949e; }
  .zone-key .swatch { width: 10px; height: 10px; border-radius: 2px; }
  .zone-key .swatch.promote { background: #3fb950; }
  .zone-key .swatch.relegate { background: #f85149; }
  .zone-key .swatch.drop { background: #f0ae3c; }
  .zone-key .swatch.champion { background: #ffd700; }
  .prow .pos { color: #6e7681; }
  .prow.pos-1 .pos { color: #f0ae3c; font-weight: 600; }
  .prow .tname { font-weight: 600; color: #c9d1d9; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prow .tname .user { color: #8b949e; font-weight: 400; font-size: 12px; margin-left: 6px; }
  .prow .tname .badge { display: inline-block; font-size: 9px; padding: 1px 5px; border-radius: 4px; background: #30363d; color: #8b949e; margin-left: 6px; vertical-align: middle; text-transform: uppercase; letter-spacing: 0.3px; }
  .prow .tname .badge.me { background: #58a6ff; color: #0d1117; font-weight: 600; }
  .prow .tname .badge.bot { background: #21262d; color: #6e7681; }
  .prow .pts { font-size: 15px; font-weight: 600; color: #f0ae3c; text-align: right; }
  .prow .played { text-align: center; color: #8b949e; }
  .prow .rec { text-align: center; color: #8b949e; font-size: 12px; }
  .prow .diff { text-align: right; color: #8b949e; font-size: 12px; }
  .prow .diff.pos { color: #3fb950; }
  .prow .diff.neg { color: #f85149; }
  .league-hdr { display: flex; align-items: baseline; gap: 14px; margin-bottom: 14px; padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; }
  .league-hdr .name { font-size: 18px; font-weight: 600; color: #c9d1d9; }
  .league-hdr .status { font-size: 11px; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.4px; }
  .league-hdr .status.running { background: #0f3d1c; color: #3fb950; }
  .league-hdr .status.complete { background: #1d2a3a; color: #58a6ff; }
  .league-hdr .pending { color: #8b949e; font-size: 12px; margin-left: auto; }
  .empty-state { text-align: center; padding: 60px 20px; color: #8b949e; background: #161b22; border: 1px dashed #30363d; border-radius: 10px; }
  .legend { padding: 8px 14px; background: #0d1117; border-radius: 6px; color: #6e7681; font-size: 11px; margin-top: 12px; display: flex; gap: 16px; }
  .queue-row { display: grid; grid-template-columns: 30px 1fr auto; gap: 10px; padding: 8px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; align-items: center; font-size: 13px; }
  .queue-row.next-up { border-left: 3px solid #3fb950; background: linear-gradient(90deg, rgba(63,185,80,0.10) 0%, #161b22 40%); }
  .queue-row.mine { border-color: #58a6ff; background: #1d2a3e; }
  .queue-row .pos { color: #6e7681; font-variant-numeric: tabular-nums; }
  .queue-row .tname { color: #c9d1d9; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .queue-row .tname .user { color: #8b949e; font-weight: 400; font-size: 12px; margin-left: 6px; }
  .queue-row .tname .badge { display: inline-block; font-size: 9px; padding: 1px 5px; border-radius: 4px; background: #30363d; color: #8b949e; margin-left: 6px; vertical-align: middle; text-transform: uppercase; letter-spacing: 0.3px; }
  .queue-row .tname .badge.me { background: #58a6ff; color: #0d1117; font-weight: 600; }
  .queue-row .tname .badge.bot { background: #21262d; color: #6e7681; }
  .queue-row .zone-tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; padding: 3px 8px; border-radius: 4px; }
  .queue-row .zone-tag.in { background: rgba(63,185,80,0.18); color: #3fb950; }
  .queue-row .zone-tag.wait { color: #6e7681; }
</style></head>
<body style="position:relative">
${AUTH_BAR_HTML}
<h1>🏛️ Pyramid</h1>
<nav>
  <a href="/">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid" class="active">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market">Market</a>
  <a href="/exhibition">Exhibition</a>
  <a href="/trades">Trades</a>
  <a href="/tournaments">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>

<div id="root"></div>

${AUTH_MODAL_HTML}
${AUTH_JS}
<script>
function esc(s){return String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}

async function load() {
  const r = await fetch('/api/pyramid');
  const data = await r.json();
  const root = document.getElementById('root');
  if (!data.league) {
    root.innerHTML = '<div class="empty-state"><h2>No leagues yet</h2><p>Run <code>mugenbattle league create</code> to start one.</p></div>';
    return;
  }
  const K = data.league.promote_per_tier || 3;
  const divCount = data.divisions.length;
  const statusCls = data.league.status;
  const header =
    '<div class="league-hdr">' +
      '<span class="name">' + esc(data.league.name) + '</span>' +
      '<span class="status ' + statusCls + '">' + statusCls + '</span>' +
      (data.pending > 0 ? '<span class="pending">' + data.pending + ' fixtures pending</span>' : '') +
    '</div>' +
    '<div class="zone-key">' +
      '<div class="k"><span class="swatch champion"></span>Champion (League 1 #1)</div>' +
      '<div class="k"><span class="swatch promote"></span>Promotion (top ' + K + ')</div>' +
      '<div class="k"><span class="swatch relegate"></span>Relegation (bottom ' + K + ')</div>' +
      '<div class="k"><span class="swatch drop"></span>Drop &amp; sit out (bottom ' + K + ' of bottom league)</div>' +
    '</div>';

  const tiers = data.divisions.map((d, i) => {
    const n = d.standings.length;
    const rowsHtml = d.standings.map((s, idx) => {
      const pos = idx + 1;
      const diff = s.matches_won - s.matches_lost;
      const diffCls = diff > 0 ? 'pos' : diff < 0 ? 'neg' : '';
      const isMine = data.viewer_team_id === s.team_id;
      const badge = isMine
        ? '<span class="badge me">you</span>'
        : s.username && s.username.startsWith('bot_')
          ? '<span class="badge bot">bot</span>'
          : '';
      // Zone classification:
      //   top K of tiers 2..N → promote (nowhere to go above tier 1)
      //   bottom K of tiers 1..(N-1) → relegate
      //   bottom K of tier N → drop (sit out one season)
      let zone = '';
      if (d.tier === 1 && pos === 1) zone = 'champion';
      else if (pos <= K && d.tier > 1) zone = 'promote';
      else if (pos > n - K && d.tier < divCount) zone = 'relegate';
      else if (pos > n - K && d.tier === divCount) zone = 'drop';

      const classes = ['prow'];
      if (isMine) classes.push('mine');
      if (zone) classes.push(zone);

      return '<div class="' + classes.join(' ') + '">' +
        '<div class="pos">' + pos + '</div>' +
        '<div class="tname"><a href="/team/' + s.team_id + '" style="color:inherit;text-decoration:none">' + esc(s.team_name) + '</a>' + badge +
          '<span class="user">@' + esc(s.username) + '</span>' +
        '</div>' +
        '<div class="played">' + s.fixtures_played + '</div>' +
        '<div class="rec">' + s.fixtures_won + '-' + s.fixtures_drawn + '-' + s.fixtures_lost + '</div>' +
        '<div class="rec">' + s.matches_won + '-' + s.matches_lost + '</div>' +
        '<div class="diff ' + diffCls + '">' + (diff > 0 ? '+' : '') + diff + '</div>' +
        '<div class="pts">' + s.points + '</div>' +
      '</div>';
    }).join('');
    return '<div class="tier t' + d.tier + '">' +
      '<div class="hdr">' +
        '<span class="tier-n">League ' + d.tier + '</span>' +
        '<span class="tname">' + esc(d.name) + '</span>' +
      '</div>' +
      '<div class="rows">' + rowsHtml + '</div>' +
    '</div>';
  }).join('');

  // Queue to get in: orphan teams in pick order. Top "slots_opening" are
  // highlighted as "in" for next season.
  let queueHtml = '';
  if (data.queue && data.queue.length) {
    const slots = data.slots_opening || 3;
    const queueRows = data.queue.map((q, i) => {
      const inNext = q.will_seat_next_season;
      const cls = ['queue-row'];
      if (inNext) cls.push('next-up');
      if (data.viewer_team_id === q.team_id) cls.push('mine');
      const badge = data.viewer_team_id === q.team_id
        ? '<span class="badge me">you</span>'
        : q.is_bot ? '<span class="badge bot">bot</span>' : '';
      const slotTag = inNext
        ? '<span class="zone-tag in">★ next season</span>'
        : '<span class="zone-tag wait">' + (i - slots + 1) + ' in line</span>';
      return '<div class="' + cls.join(' ') + '">' +
        '<div class="pos">' + (i + 1) + '</div>' +
        '<div class="tname"><a href="/team/' + q.team_id + '" style="color:inherit;text-decoration:none">' + esc(q.team_name) + '</a>' + badge +
          '<span class="user">@' + esc(q.username) + '</span>' +
        '</div>' +
        slotTag +
      '</div>';
    }).join('');
    queueHtml =
      '<div class="tier" style="margin-top:30px">' +
        '<div class="hdr">' +
          '<span class="tier-n" style="color:#8b949e">Queue to get in</span>' +
          '<span class="tname">Bottom-tier seats opening at next season transition: ' + slots + '</span>' +
        '</div>' +
        '<div class="rows queue">' + queueRows + '</div>' +
      '</div>';
  }
  root.innerHTML = header + tiers + queueHtml +
    '<div class="legend">' +
      '<span>Columns: pos · team · played · W-D-L · match W-L · diff · pts</span>' +
    '</div>';
}

load();
setInterval(load, 5000);
</script>
</body></html>`;

const MARKET_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Market · MugenBattle</title>
<style>${COMMON_CSS}
  .wallet { display: flex; align-items: center; gap: 14px; padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 16px; }
  .wallet .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  .wallet .balance { font-size: 22px; font-weight: 600; color: #3fb950; font-variant-numeric: tabular-nums; }
  .wallet .hint { color: #6e7681; font-size: 12px; margin-left: auto; }
  .market-controls { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; }
  .market-controls input { flex: 1; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; font-size: 13px; }
  .market-controls .count { color: #8b949e; font-size: 12px; }
  .market-controls select { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; font-size: 12px; }
  .market-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  .market-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; display: flex; gap: 10px; }
  .market-card .port { width: 56px; height: 56px; background: #0d1117; border-radius: 6px; image-rendering: pixelated; object-fit: contain; border: 1px solid #30363d; }
  .market-card .body { flex: 1; min-width: 0; }
  .market-card .name { font-size: 14px; font-weight: 600; color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .market-card .author { color: #8b949e; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .market-card .record { color: #8b949e; font-size: 11px; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .market-card .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 8px; }
  .market-card .price { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; color: #f0ae3c; }
  .market-card .price.free { color: #3fb950; }
  .market-card button { background: #238636; color: white; border: 1px solid #2ea043; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  .market-card button:hover { background: #2ea043; }
  .market-card button:disabled { background: #21262d; border-color: #30363d; color: #6e7681; cursor: not-allowed; }
  .market-card.bought { opacity: 0.5; pointer-events: none; }
  .market-card { position: relative; }
  .market-card.followed { border-color: #f0ae3c; box-shadow: 0 0 0 1px rgba(240, 174, 60, 0.25); }
  .market-card .card-star { position: absolute; top: 6px; right: 6px; background: transparent; border: 0; color: #6e7681; font-size: 16px; cursor: pointer; padding: 2px 6px; line-height: 1; }
  .market-card .card-star:hover { color: #f0ae3c; }
  .market-card .card-star.on { color: #f0ae3c; }
  .market-card.stage-card-market { flex-direction: column; padding: 0; overflow: hidden; gap: 0; }
  .market-card.stage-card-market .stage-preview { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: #0d1117; border-bottom: 1px solid #30363d; display: block; image-rendering: pixelated; }
  .market-card.stage-card-market .body { padding: 10px 12px; }
  .market-msg { font-size: 11px; margin-top: 4px; }
  .market-msg.ok { color: #3fb950; }
  .market-msg.err { color: #f85149; }
  .empty-state { text-align: center; padding: 40px 20px; color: #8b949e; background: #161b22; border: 1px dashed #30363d; border-radius: 10px; }
</style></head>
<body style="position:relative">
${AUTH_BAR_HTML}
<h1>🛒 Market</h1>
<nav>
  <a href="/">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market" class="active">Market</a>
  <a href="/exhibition">Exhibition</a>
  <a href="/trades">Trades</a>
  <a href="/tournaments">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>

<div class="wallet" id="wallet-authed" style="display:none">
  <span class="label">Balance</span>
  <span class="balance" id="wallet-balance">—</span>
  <span class="hint">Prize money: 50¢ per fixture win · 25¢ per draw</span>
</div>
<div class="empty-state" id="signed-out" style="display:none">
  <h2>Sign in to buy fighters</h2>
  <p>Use the "Sign in" button in the top right. You can still browse the market below.</p>
</div>

<h2 style="font-size:14px;margin:16px 0 8px;color:#8b949e;text-transform:uppercase;letter-spacing:0.4px">Player listings <span id="listings-count" style="color:#6e7681">—</span></h2>
<div class="market-grid" id="listings"></div>
<div id="no-listings" class="empty-state" style="display:none;margin-bottom:16px">No active player listings right now.</div>

<h2 style="font-size:14px;margin:20px 0 8px;color:#8b949e;text-transform:uppercase;letter-spacing:0.4px">Unclaimed fighters</h2>
<div class="market-controls">
  <input type="search" id="q" placeholder="Search by name or author…">
  <select id="sort">
    <option value="latest_desc">Latest added</option>
    <option value="price_asc">Price ↑</option>
    <option value="price_desc">Price ↓</option>
    <option value="wins_desc">Wins ↓</option>
    <option value="name">Name</option>
  </select>
  <span class="count" id="count">—</span>
</div>
<div class="market-grid" id="grid"></div>

<h2 style="font-size:14px;margin:20px 0 8px;color:#8b949e;text-transform:uppercase;letter-spacing:0.4px">Stages <span id="stages-count" style="color:#6e7681">—</span></h2>
<div class="market-grid" id="stages"></div>
<div id="no-stages" class="empty-state" style="display:none;margin-bottom:16px">No stages listed right now.</div>

${AUTH_MODAL_HTML}
${AUTH_JS}
<script>
function esc(s){return String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
function cents(n){return n === 0 ? 'Free' : '$' + (n/100).toFixed(2)}
let all = [];
let me = null;

window.onAuthStateChange = async (state) => {
  me = state;
  document.getElementById('signed-out').style.display = state.authenticated ? 'none' : '';
  if (state.authenticated && !state.needs_username) {
    await refreshWallet();
    document.getElementById('wallet-authed').style.display = '';
  } else {
    document.getElementById('wallet-authed').style.display = 'none';
  }
  render();
};

async function refreshWallet() {
  const r = await fetch('/api/me/wallet');
  if (!r.ok) return;
  const w = await r.json();
  document.getElementById('wallet-balance').textContent = cents(w.balance_cents);
}

async function loadMarket() {
  const [m, listings, stages, stageListings] = await Promise.all([
    fetch('/api/market').then(r => r.json()),
    fetch('/api/market/listings?limit=200').then(r => r.json()),
    fetch('/api/market/stages?limit=200').then(r => r.json()),
    fetch('/api/market/stage-listings?limit=100').then(r => r.json()),
  ]);
  all = m;
  renderListings(listings);
  renderStages(stages, stageListings);
  render();
}

function renderStages(pool, listings) {
  const host = document.getElementById('stages');
  const none = document.getElementById('no-stages');
  const combined = [
    ...listings.map(l => ({ ...l, id: l.stage_id, isListing: true })),
    ...pool.map(s => ({ ...s, isListing: false })),
  ];
  document.getElementById('stages-count').textContent = combined.length ? '(' + combined.length + ')' : '';
  if (!combined.length) { host.innerHTML = ''; none.style.display = ''; return; }
  none.style.display = 'none';
  const canBuy = !!(me && me.authenticated && !me.needs_username);
  host.innerHTML = combined.map(s => {
    const priceLabel = cents(s.price_cents);
    const sellerLine = s.isListing
      ? '<div class="author">from @' + esc(s.seller_username) + '</div>'
      : '<div class="author">' + esc(s.author || 'unknown') + '</div>';
    const isMe = canBuy && s.isListing && me.username === s.seller_username;
    const buyLabel = s.isListing ? (isMe ? 'Your listing' : 'Buy') : 'Buy';
    const buyOnClick = s.isListing ? 'buyStageListing' : 'buyStage';
    const preview = '<img class="stage-preview" src="/stage-preview/' + encodeURIComponent(s.file_name) + '.png" alt="" onerror="this.style.display=\\'none\\'">';
    return '<div class="market-card stage-card-market">' +
      preview +
      '<div class="body">' +
        '<div class="name">' + esc(s.display_name || s.file_name) + '</div>' +
        sellerLine +
        '<div class="record">used ' + s.times_used + ' times</div>' +
        '<div class="foot">' +
          '<span class="price ' + (s.price_cents === 0 ? 'free' : '') + '">' + priceLabel + '</span>' +
          (canBuy && !isMe
            ? '<button onclick="' + buyOnClick + '(' + s.id + ', this)">' + buyLabel + '</button>'
            : '<button disabled>' + (isMe ? buyLabel : 'Sign in') + '</button>') +
        '</div>' +
        '<div class="market-msg" id="smsg-' + s.id + '"></div>' +
      '</div></div>';
  }).join('');
}

async function buyStage(stageId, btn) {
  btn.disabled = true; btn.textContent = '…';
  const msg = document.getElementById('smsg-' + stageId);
  msg.className = 'market-msg';
  const r = await fetch('/api/market/buy-stage', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ stage_id: stageId }),
  });
  const body = await r.json();
  if (r.ok) {
    msg.className = 'market-msg ok';
    msg.textContent = 'Home stage acquired · paid ' + cents(body.price_cents);
    btn.closest('.market-card').classList.add('bought');
    await refreshWallet();
    loadMarket();
  } else {
    msg.className = 'market-msg err';
    const extra = body.need != null ? ' (need ' + cents(body.need) + ', have ' + cents(body.have) + ')' : '';
    msg.textContent = 'Failed: ' + (body.error || 'unknown') + extra;
    btn.disabled = false; btn.textContent = 'Buy';
  }
}

async function buyStageListing(stageId, btn) {
  btn.disabled = true; btn.textContent = '…';
  const msg = document.getElementById('smsg-' + stageId);
  msg.className = 'market-msg';
  const r = await fetch('/api/market/buy-stage-listing', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ stage_id: stageId }),
  });
  const body = await r.json();
  if (r.ok) {
    msg.className = 'market-msg ok';
    msg.textContent = 'Home stage acquired · paid ' + cents(body.price_cents);
    btn.closest('.market-card').classList.add('bought');
    await refreshWallet();
    loadMarket();
  } else {
    msg.className = 'market-msg err';
    const extra = body.need != null ? ' (need ' + cents(body.need) + ', have ' + cents(body.have) + ')' : '';
    msg.textContent = 'Failed: ' + (body.error || 'unknown') + extra;
    btn.disabled = false; btn.textContent = 'Buy';
  }
}

function renderListings(listings) {
  const host = document.getElementById('listings');
  const none = document.getElementById('no-listings');
  document.getElementById('listings-count').textContent = listings.length ? '(' + listings.length + ')' : '';
  if (!listings.length) {
    host.innerHTML = '';
    none.style.display = '';
    return;
  }
  none.style.display = 'none';
  const canBuy = !!(me && me.authenticated && !me.needs_username);
  host.innerHTML = listings.map(l => {
    const isMe = canBuy && me.username === l.seller_username;
    return '<div class="market-card" data-owned="' + l.owned_fighter_id + '">' +
      '<img class="port" src="/portrait/' + encodeURIComponent(l.file_name) + '.png" onerror="this.style.visibility=\\'hidden\\'">' +
      '<div class="body">' +
        '<div class="name">' + esc(l.display_name) + '</div>' +
        '<div class="author">as ' + esc(l.master_display_name || l.file_name) +
          ' · from @' + esc(l.seller_username) + '</div>' +
        '<div class="record">' + l.matches_won + 'W · ' + l.matches_lost + 'L · ' + l.matches_drawn + 'D</div>' +
        '<div class="foot">' +
          '<span class="price ' + (l.price_cents === 0 ? 'free' : '') + '">' + cents(l.price_cents) + '</span>' +
          (isMe
            ? '<button disabled>Your listing</button>'
            : canBuy
              ? '<button onclick="buyListing(' + l.owned_fighter_id + ', this)">Buy</button>'
              : '<button disabled>Sign in</button>') +
        '</div>' +
        '<div class="market-msg" id="lmsg-' + l.owned_fighter_id + '"></div>' +
      '</div></div>';
  }).join('');
}

async function buyListing(ownedId, btn) {
  btn.disabled = true; btn.textContent = '…';
  const msg = document.getElementById('lmsg-' + ownedId);
  msg.className = 'market-msg';
  const r = await fetch('/api/market/buy-listing', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ owned_fighter_id: ownedId }),
  });
  const body = await r.json();
  if (r.ok) {
    msg.className = 'market-msg ok';
    msg.textContent = 'Added to bench · paid ' + cents(body.price_cents);
    btn.closest('.market-card').classList.add('bought');
    await refreshWallet();
    // reload listings so the sold one disappears
    fetch('/api/market/listings?limit=200').then(r => r.json()).then(renderListings);
  } else {
    msg.className = 'market-msg err';
    const extra = body.need != null ? ' (need ' + cents(body.need) + ', have ' + cents(body.have) + ')' : '';
    msg.textContent = 'Failed: ' + (body.error || 'unknown') + extra;
    btn.disabled = false; btn.textContent = 'Buy';
  }
}

function render() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  const sort = document.getElementById('sort').value;
  let rows = all.slice();
  if (q) {
    rows = rows.filter(m => (m.display_name || '').toLowerCase().includes(q) ||
                            (m.file_name || '').toLowerCase().includes(q) ||
                            (m.author || '').toLowerCase().includes(q));
  }
  rows.sort((a, b) => {
    // Followed masters always sort to the top — the whole reason for stars.
    if (!!a.followed !== !!b.followed) return a.followed ? -1 : 1;
    if (sort === 'latest_desc') return (b.created_at || '').localeCompare(a.created_at || '') || (b.id - a.id);
    if (sort === 'price_asc') return a.price_cents - b.price_cents || (a.display_name||'').localeCompare(b.display_name||'');
    if (sort === 'price_desc') return b.price_cents - a.price_cents;
    if (sort === 'wins_desc') return b.matches_won - a.matches_won;
    return (a.display_name || a.file_name || '').localeCompare(b.display_name || b.file_name || '');
  });
  document.getElementById('count').textContent = rows.length + ' available';
  document.getElementById('grid').innerHTML = rows.map(cardHtml).join('');
}

function cardHtml(m) {
  const canBuy = !!(me && me.authenticated && !me.needs_username);
  const followCls = m.followed ? ' followed' : '';
  const starOn = m.followed ? ' on' : '';
  const starGlyph = m.followed ? '★' : '☆';
  const starTip = m.followed
    ? 'Unfollow this fighter — won\\'t auto-pin to top anymore'
    : 'Follow this fighter — pins them to the top of the market';
  return '<div class="market-card' + followCls + '" data-id="' + m.id + '">' +
    '<button class="card-star star' + starOn + '" title="' + starTip + '" aria-label="' + starTip + '" onclick="toggleMarketFollow(' + m.id + ', event)">' + starGlyph + '</button>' +
    '<img class="port" src="/portrait/' + encodeURIComponent(m.file_name) + '.png" onerror="this.style.visibility=\\'hidden\\'">' +
    '<div class="body">' +
      '<div class="name">' + esc(m.display_name || m.file_name) + '</div>' +
      '<div class="author">' + esc(m.author || 'unknown') + '</div>' +
      '<div class="record">' + m.matches_won + 'W · ' + m.matches_lost + 'L · ' + m.matches_drawn + 'D</div>' +
      '<div class="foot">' +
        '<span class="price ' + (m.price_cents === 0 ? 'free' : '') + '">' + cents(m.price_cents) + '</span>' +
        (canBuy
          ? '<button onclick="buy(' + m.id + ', this)">Buy</button>'
          : '<button disabled>Sign in</button>') +
      '</div>' +
      '<div class="market-msg" id="msg-' + m.id + '"></div>' +
    '</div></div>';
}

async function toggleMarketFollow(masterId, evt) {
  if (evt) { evt.stopPropagation(); evt.preventDefault(); }
  if (!me || !me.authenticated) { alert('Sign in to follow.'); return; }
  const m = all.find(x => x.id === masterId);
  if (!m) return;
  m.followed = !m.followed;
  if (m.followed) {
    fetch('/api/follow', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ kind: 'master', id: masterId }) });
  } else {
    fetch('/api/follow/master/' + masterId, { method: 'DELETE' });
  }
  render();
}

async function buy(masterId, btn) {
  btn.disabled = true; btn.textContent = '…';
  const msg = document.getElementById('msg-' + masterId);
  msg.className = 'market-msg';
  const r = await fetch('/api/market/buy', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ master_fighter_id: masterId }),
  });
  const body = await r.json();
  if (r.ok) {
    msg.className = 'market-msg ok';
    msg.textContent = 'Added to bench · paid ' + cents(body.price_cents);
    const card = btn.closest('.market-card');
    card.classList.add('bought');
    // drop from local list so re-sort doesn't show it again
    all = all.filter(m => m.id !== masterId);
    await refreshWallet();
  } else {
    msg.className = 'market-msg err';
    const extra = body.need != null ? ' (need ' + cents(body.need) + ', have ' + cents(body.have) + ')' : '';
    msg.textContent = 'Failed: ' + (body.error || 'unknown') + extra;
    btn.disabled = false; btn.textContent = 'Buy';
  }
}

document.getElementById('q').addEventListener('input', render);
document.getElementById('sort').addEventListener('change', render);
loadMarket();
</script>
</body></html>`;

const TEAM_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>My Team · MugenBattle</title>
<style>${COMMON_CSS}
  .wait-banner { padding: 14px 18px; background: #1d2a3a; border: 1px solid #30436a; border-left: 3px solid #58a6ff; border-radius: 10px; margin-bottom: 14px; color: #c9d1d9; font-size: 13px; line-height: 1.5; }
  .wait-banner .head { font-size: 14px; font-weight: 600; color: #c9d1d9; margin-bottom: 4px; }
  .wait-banner .eta { color: #58a6ff; font-weight: 600; }
  .wait-banner .meta { color: #8b949e; font-size: 12px; margin-top: 4px; }
  .notice { padding: 12px 16px; background: #2d2616; border: 1px solid #5a4a1f; border-left: 3px solid #f0ae3c; border-radius: 8px; margin-bottom: 10px; color: #c9d1d9; font-size: 13px; position: relative; }
  .notice .head { font-weight: 600; color: #f0ae3c; margin-bottom: 4px; font-size: 13px; }
  .notice ul { margin: 6px 0 0; padding-left: 18px; color: #c9d1d9; }
  .notice li { font-size: 12px; }
  .notice .dismiss { position: absolute; top: 8px; right: 10px; background: transparent; border: 0; color: #8b949e; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 6px; }
  .notice .dismiss:hover { color: #c9d1d9; }
  .wallet-row { display: flex; gap: 18px; align-items: center; padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 14px; }
  .wallet-row .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  .wallet-row .balance { font-size: 20px; font-weight: 600; color: #3fb950; font-variant-numeric: tabular-nums; }
  .wallet-row .market-link { margin-left: auto; background: transparent; color: #58a6ff; border: 1px solid #58a6ff; padding: 6px 14px; border-radius: 6px; font-size: 13px; text-decoration: none; }
  .wallet-row .market-link:hover { background: #58a6ff; color: #0d1117; }
  .team-header { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; padding: 14px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; }
  .rotate-panel { padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 14px; }
  .rotate-row { display: flex; gap: 12px; align-items: center; }
  .rotate-row .rotate-label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: #c9d1d9; cursor: pointer; font-weight: 600; white-space: nowrap; }
  .rotate-row .rotate-label input { width: 16px; height: 16px; cursor: pointer; }
  .rotate-row .rotate-hint-inline { color: #6e7681; font-size: 11px; flex: 1; }
  .rotate-row .msg { margin-left: auto; }
  .rotate-config { margin-top: 10px; padding-top: 10px; border-top: 1px solid #21262d; display: flex; flex-direction: column; gap: 10px; }
  .rotate-config.disabled { opacity: 0.4; pointer-events: none; }
  .rule-row { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; }
  .rule-row .rule-check { display: flex; gap: 8px; align-items: center; font-size: 13px; color: #c9d1d9; cursor: pointer; white-space: nowrap; }
  .rule-row .rule-check input { width: 15px; height: 15px; cursor: pointer; }
  .rule-row .rule-suffix { color: #8b949e; font-size: 12px; }
  .rule-row input[type=range] { accent-color: #58a6ff; }
  .rule-row input[type=number] { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px; padding: 4px 8px; font-size: 13px; font-variant-numeric: tabular-nums; }
  .rotate-threshold-val { text-align: right; color: #f0ae3c; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 15px; min-width: 40px; }
  .rotate-hint { color: #8b949e; font-size: 11px; line-height: 1.5; margin-top: 4px; padding-top: 8px; border-top: 1px dashed #21262d; }
  .rotate-hint b { color: #c9d1d9; font-variant-numeric: tabular-nums; }
  .team-header label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  .team-header input { flex: 1; background:#0d1117; border:1px solid #30363d; color:#c9d1d9; padding: 8px 12px; border-radius: 6px; font-size: 16px; font-weight: 600; }
  .team-header button { background:#238636; color:white; border:1px solid #2ea043; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .team-header button:hover { background:#2ea043; }
  .team-header .msg { font-size: 12px; min-width: 60px; }
  .team-header .msg.ok { color: #3fb950; }
  .team-header .msg.err { color: #f85149; }
  .roster-section { margin-bottom: 18px; }
  .roster-section h2 { font-size: 12px; text-transform: uppercase; color: #8b949e; margin: 0 0 8px; letter-spacing: 0.4px; }
  .fighter-row { display: grid; grid-template-columns: 20px 44px 2fr 2fr 1fr 0.8fr 0.6fr; gap: 12px; padding: 10px 14px; align-items: center; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 6px; cursor: pointer; transition: border-color 0.1s, opacity 0.1s; }
  .fighter-row .fr-port { width: 44px; height: 44px; background: #0d1117; border-radius: 4px; object-fit: contain; image-rendering: pixelated; border: 1px solid #21262d; }
  .fighter-row:hover { border-color: #58a6ff; }
  .fighter-row[draggable=true] { cursor: grab; }
  .fighter-row[draggable=true]:active { cursor: grabbing; }
  .fighter-row.dragging { opacity: 0.4; }
  .fighter-row.drop-target { border-color: #f0ae3c; background: #1d1d14; }
  .fighter-row .fr-grip { color: #6e7681; font-size: 12px; cursor: grab; user-select: none; }
  .fighter-row[data-slot=for_sale] .fr-grip { visibility: hidden; }
  .fighter-row .fr-name { font-size: 14px; font-weight: 600; color: #c9d1d9; }
  .fighter-row .fr-master { color: #8b949e; font-size: 12px; font-style: italic; }
  .fighter-row .fr-stats { color: #8b949e; font-size: 12px; font-variant-numeric: tabular-nums; }
  .fighter-row .fr-stam { font-size: 12px; font-variant-numeric: tabular-nums; }
  .fighter-row .fr-edit { text-align: right; color: #58a6ff; font-size: 12px; }
  .roster-empty { padding: 14px; color: #6e7681; font-size: 12px; background: #0d1117; border-radius: 8px; border: 1px dashed #30363d; text-align: center; }
  .import-box { padding: 12px 14px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
  .import-box .import-hint { color: #8b949e; font-size: 12px; margin-bottom: 10px; }
  .import-box .import-row { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
  .import-box input[type=file] { flex: 1; color: #c9d1d9; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 6px 10px; font-size: 12px; }
  .import-box button { background: #238636; color: white; border: 1px solid #2ea043; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .import-box button:hover { background: #2ea043; }
  .import-box button:disabled { background: #21262d; border-color: #30363d; color: #6e7681; cursor: not-allowed; }
  .import-box .msg { font-size: 12px; min-width: 120px; }
  .import-box .msg.ok { color: #3fb950; }
  .import-box .msg.err { color: #f85149; }
  .imports-list { margin-top: 10px; font-size: 12px; }
  .imports-list .import-row-rec { display: grid; grid-template-columns: 1.5fr 1fr 2fr; gap: 10px; padding: 6px 8px; border-top: 1px solid #21262d; align-items: center; }
  .imports-list .status-approved { color: #3fb950; font-weight: 600; }
  .imports-list .status-rejected { color: #f85149; font-weight: 600; }
  .imports-list .status-other { color: #f0ae3c; }
  .schedule-row { display: grid; grid-template-columns: 60px 1.5fr 50px 1.5fr 70px 70px; gap: 2px 10px; padding: 8px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; font-size: 12px; margin-bottom: 4px; align-items: center; font-variant-numeric: tabular-nums; }
  .schedule-row .sched-round { color: #8b949e; }
  .schedule-row .sched-team { text-align: left; }
  .schedule-row .sched-team.away { text-align: right; }
  .schedule-row .sched-team .us { color: #58a6ff; font-weight: 600; }
  .schedule-row .sched-team .sched-team-link { color: #c9d1d9; text-decoration: none; }
  .schedule-row .sched-team .sched-team-link:hover { color: #58a6ff; text-decoration: underline; }
  .schedule-row .sched-fighter { color: #6e7681; font-size: 11px; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .schedule-row .sched-fighter.home { grid-column: 2; }
  .schedule-row .sched-fighter.away { grid-column: 4; text-align: right; }
  .schedule-row .sched-vs { color: #6e7681; text-align: center; }
  .schedule-row .sched-score { color: #f0ae3c; font-weight: 600; text-align: center; }
  .schedule-row .sched-score.loss { color: #f85149; }
  .schedule-row .sched-score.win { color: #3fb950; }
  .schedule-row .sched-score.draw { color: #8b949e; }
  .schedule-row .sched-status { color: #6e7681; font-size: 11px; text-align: right; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
  .schedule-row .sched-status.win { color: #3fb950; }
  .schedule-row .sched-status.loss { color: #f85149; }
  .schedule-row .sched-status.draw { color: #8b949e; }
  .schedule-row .sched-status.running { color: #f0ae3c; }
  .history-list { margin-top: 10px; }
  .history-row { display: grid; grid-template-columns: 40px 1fr 60px; gap: 8px; padding: 4px 8px; font-size: 11px; border-bottom: 1px solid #21262d; align-items: center; }
  .history-row .res-w { color: #3fb950; font-weight: 600; }
  .history-row .res-l { color: #f85149; font-weight: 600; }
  .history-row .res-d { color: #8b949e; }
  .history-row .opp { color: #c9d1d9; }
  .history-row .rounds { color: #6e7681; text-align: right; font-variant-numeric: tabular-nums; }
  .stage-card { display: grid; grid-template-columns: 180px 1fr; gap: 14px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  .stage-card .home-stage-preview { width: 180px; aspect-ratio: 4 / 3; object-fit: cover; background: #0d1117; image-rendering: pixelated; }
  .stage-card .stage-body { padding: 12px 14px 12px 0; }
  .stage-card .stage-head { margin-bottom: 10px; }
  .stage-card .stage-name { font-size: 15px; font-weight: 600; color: #c9d1d9; }
  .stage-card .stage-meta { color: #8b949e; font-size: 11px; margin-top: 2px; }
  .stage-card .stage-row { display: flex; gap: 10px; align-items: center; font-size: 13px; }
  .stage-card .stage-row label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
  .stage-card .stage-row input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; padding: 6px 10px; border-radius: 4px; font-size: 12px; }
  .stage-card .stage-row button { background: #238636; color: white; border: 1px solid #2ea043; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .stage-card .stage-row button:hover { background: #2ea043; }
  .empty-state { text-align: center; padding: 60px 20px; color: #8b949e; background: #161b22; border: 1px dashed #30363d; border-radius: 10px; }
  .empty-state h2 { color: #c9d1d9; margin-top: 0; }
  .editor { max-width: 820px !important; }
  .editor .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
  .editor .stats .stat { background: #0d1117; padding: 10px; border-radius: 6px; text-align: center; }
  .editor .stats .stat .v { font-size: 20px; font-weight: 600; color: #c9d1d9; }
  .editor .stats .stat .l { font-size: 10px; text-transform: uppercase; color: #8b949e; }
  .editor .row { display: flex; gap: 8px; align-items: center; margin: 10px 0; font-size: 13px; }
  .editor .row label { color: #8b949e; min-width: 70px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
  .editor .row input { flex: 1; background:#0d1117; border:1px solid #30363d; color:#c9d1d9; padding: 6px 10px; border-radius: 4px; font-size: 13px; }
  .editor .row button { background:#238636; color:white; border:1px solid #2ea043; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .editor .row button:hover { background:#2ea043; }
  .editor .row .msg { font-size: 12px; min-width: 100px; }
  .editor .row .msg.ok { color: #3fb950; }
  .editor .row .msg.err { color: #f85149; }
  .editor textarea { width: 100%; height: 420px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 10px; resize: vertical; box-sizing: border-box; }
  .editor .ai-hdr { font-size: 11px; color: #8b949e; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0.4px; }
</style></head>
<body style="position:relative">
${AUTH_BAR_HTML}
<h1>🏋️ My Team</h1>
<nav>
  <a href="/">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team" class="active">My Team</a>
  <a href="/market">Market</a>
  <a href="/exhibition">Exhibition</a>
  <a href="/trades">Trades</a>
  <a href="/tournaments">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>

<div id="signed-out" class="empty-state" style="display:none">
  <h2>Sign in to manage your team</h2>
  <p>Use the "Sign in" button in the top right to get a one-time code.</p>
</div>

<div id="team-root" style="display:none">
  <div id="wait-banner" class="wait-banner" style="display:none"></div>
  <div id="notices-host"></div>
  <div class="wallet-row">
    <span class="label">Wallet</span>
    <span class="balance" id="wallet-balance">—</span>
    <a class="market-link" href="/market">Browse market →</a>
  </div>
  <div class="team-header">
    <label>Team</label>
    <input type="text" id="team-name" maxlength="40">
    <button onclick="saveTeamName()">Rename</button>
    <span class="msg" id="team-name-msg"></span>
  </div>

  <div class="rotate-panel">
    <div class="rotate-row">
      <label class="rotate-label">
        <input type="checkbox" id="auto-rotate" onchange="saveRotation()">
        <span>Auto-rotate</span>
      </label>
      <span class="rotate-hint-inline">Rotates to the next-priority active fighter when any enabled rule below fires. If every fighter is skipped, priority 0 plays anyway.</span>
      <span class="msg" id="rotate-msg"></span>
    </div>
    <div class="rotate-config" id="rotate-config">
      <div class="rule-row" style="gap:18px;flex-wrap:wrap">
        <span class="rule-suffix">Mode:</span>
        <label class="rule-check"><input type="radio" name="rotation-mode" id="mode-conditional" value="stamina" onchange="saveRotation()"><span>Conditional</span></label>
        <label class="rule-check"><input type="radio" name="rotation-mode" id="mode-seq-active" value="sequential_active" onchange="saveRotation()"><span>Sequential — active</span></label>
        <label class="rule-check"><input type="radio" name="rotation-mode" id="mode-seq-full" value="sequential_full" onchange="saveRotation()"><span>Sequential — active + bench</span></label>
      </div>
      <div class="rule-row" id="cond-row-stamina">
        <label class="rule-check">
          <input type="checkbox" id="rotate-on-stamina" onchange="saveRotation()">
          <span>Swap when stamina drops below</span>
        </label>
        <input type="range" id="rotate-threshold" min="0" max="1" step="0.05" value="0.85" oninput="updateThresholdLabel()" onchange="saveRotation()">
        <span class="rotate-threshold-val" id="rotate-threshold-val">0.85</span>
      </div>
      <div class="rule-row" id="cond-row-losses">
        <label class="rule-check">
          <input type="checkbox" id="rotate-on-losses" onchange="saveRotation()">
          <span>Swap after</span>
        </label>
        <input type="number" id="rotate-loss-streak" min="1" max="20" step="1" value="3" onchange="saveRotation()" style="max-width:70px">
        <span class="rule-suffix">consecutive losses</span>
      </div>
      <div class="rotate-hint" id="rotate-hint">
        Rotation is between fixtures only. The fielded fighter loses <b>0.20</b>
        stamina after their match; every other roster fighter on your team
        gains <b>0.25</b> while resting (capped at 1.00).
      </div>
    </div>
  </div>

  <div class="roster-section">
    <h2>Active lineup</h2>
    <div id="active-slots"></div>
  </div>
  <div class="roster-section">
    <h2>Bench</h2>
    <div id="bench-slots"></div>
  </div>
  <div class="roster-section" id="forsale-section" style="display:none">
    <h2>Listed for sale</h2>
    <div id="forsale-slots"></div>
  </div>

  <div class="roster-section">
    <h2>Home stage</h2>
    <div id="home-stage"></div>
  </div>

  <div class="roster-section" id="schedule-section" style="display:none">
    <h2>Schedule</h2>
    <div id="schedule"></div>
  </div>

  <div class="roster-section">
    <h2>Import a character</h2>
    <div class="import-box">
      <div class="import-hint">Upload a MUGEN character .zip. Must have a single top-level folder (&lt;name&gt;/) containing &lt;name&gt;.def. Max 100 MB.</div>
      <div class="import-row">
        <input type="file" id="import-file" accept=".zip,application/zip">
        <button id="import-btn" onclick="doImport()">Upload</button>
        <span class="msg" id="import-msg"></span>
      </div>
      <div class="imports-list" id="imports-list"></div>
    </div>
  </div>
</div>

${AUTH_MODAL_HTML}

<div class="modal-bg" id="edit-bg" onclick="if(event.target===this)closeEditor()">
  <div class="modal editor"><div class="modal-shell">
    <div class="close" onclick="closeEditor()">×</div>
    <div id="edit-body"></div>
  </div></div>
</div>

${AUTH_JS}
<script>
function esc(s){return String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
let currentTeam = null;

window.onAuthStateChange = (me) => {
  if (!me.authenticated || me.needs_username) {
    document.getElementById('signed-out').style.display = '';
    document.getElementById('team-root').style.display = 'none';
  } else {
    document.getElementById('signed-out').style.display = 'none';
    loadTeam();
  }
};

function fmtCents(n){return n === 0 ? '$0.00' : '$' + (n/100).toFixed(2)}

async function loadTeam() {
  const r = await fetch('/api/me/team');
  if (!r.ok) {
    document.getElementById('team-root').style.display = 'none';
    document.getElementById('signed-out').style.display = '';
    return;
  }
  const team = await r.json();
  if (team.error) {
    document.getElementById('team-root').innerHTML = '<div class="empty-state"><h2>No team yet</h2><p>Finish signup to get your starter roster.</p></div>';
    document.getElementById('team-root').style.display = '';
    return;
  }
  currentTeam = team;
  renderTeam();
  document.getElementById('team-root').style.display = '';

  const w = await fetch('/api/me/wallet').then(r => r.ok ? r.json() : null);
  if (w) document.getElementById('wallet-balance').textContent = fmtCents(w.balance_cents);

  await loadSchedule();
  await loadWaitState();
  await loadHomeStage();
}

async function loadHomeStage() {
  const host = document.getElementById('home-stage');
  if (!host) return;
  const r = await fetch('/api/me/home-stage');
  if (!r.ok) { host.innerHTML = ''; return; }
  const s = await r.json();
  if (!s) {
    host.innerHTML = '<div class="roster-empty">You don\\'t own a stage. <a href="/market" style="color:#58a6ff">Browse the stage market →</a></div>';
    return;
  }
  const listed = s.listing_price_cents != null;
  const preview = '<img class="home-stage-preview" src="/stage-preview/' + encodeURIComponent(s.file_name) + '.png" alt="" onerror="this.style.display=\\'none\\'">';
  const releaseBtn = '<button onclick="stageRelease(' + s.id + ')" style="background:transparent;color:#f85149;border:1px solid #f85149">Release</button>';
  host.innerHTML =
    '<div class="stage-card">' +
      preview +
      '<div class="stage-body">' +
        '<div class="stage-head">' +
          '<div class="stage-name">' + esc(s.display_name || s.file_name) + '</div>' +
          '<div class="stage-meta">' + (s.author ? 'by ' + esc(s.author) + ' · ' : '') + 'used ' + s.times_used + ' times</div>' +
        '</div>' +
        (listed
          ? '<div class="stage-row"><span>Listed at <b>' + fmtCents(s.listing_price_cents) + '</b></span>' +
            '<button onclick="stageUnlist(' + s.id + ')">Unlist</button>' +
            releaseBtn +
            '<span class="msg" id="stage-msg"></span></div>'
          : '<div class="stage-row"><label>List for</label>' +
            '<input type="number" id="stage-price" min="0" step="1" value="0" style="max-width:120px">' +
            '<span style="color:#8b949e;font-size:11px">cents</span>' +
            '<button onclick="stageList(' + s.id + ')">List for sale</button>' +
            releaseBtn +
            '<span class="msg" id="stage-msg"></span></div>') +
      '</div>' +
    '</div>';
}

async function stageRelease(id) {
  if (!confirm('Release this home stage back to the pool? No money back.')) return;
  const msg = document.getElementById('stage-msg');
  msg.className = 'msg'; msg.textContent = '…';
  const r = await fetch('/api/stage/' + id + '/release', { method: 'POST' });
  const body = await r.json();
  if (r.ok) { loadHomeStage(); } else {
    msg.className = 'msg err'; msg.textContent = body.error || 'error';
  }
}

async function stageList(id) {
  const price = parseInt(document.getElementById('stage-price').value, 10);
  const r = await fetch('/api/stage/' + id + '/list-for-sale', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ price_cents: price }),
  });
  const body = await r.json();
  const msg = document.getElementById('stage-msg');
  msg.className = 'msg ' + (r.ok ? 'ok' : 'err');
  msg.textContent = r.ok ? 'listed' : (body.error || 'error');
  if (r.ok) setTimeout(loadHomeStage, 400);
}
async function stageUnlist(id) {
  const r = await fetch('/api/stage/' + id + '/unlist', { method: 'POST' });
  const body = await r.json();
  const msg = document.getElementById('stage-msg');
  msg.className = 'msg ' + (r.ok ? 'ok' : 'err');
  msg.textContent = r.ok ? 'unlisted' : (body.error || 'error');
  if (r.ok) setTimeout(loadHomeStage, 400);
}

function fmtEta(seconds) {
  if (seconds < 120) return 'under a minute';
  if (seconds < 3600) return '~' + Math.max(1, Math.round(seconds / 60)) + ' minutes';
  if (seconds < 3600 * 24) {
    const h = seconds / 3600;
    return '~' + (h < 2 ? h.toFixed(1) : Math.round(h)) + ' hours';
  }
  return '~' + Math.round(seconds / 86400) + ' days';
}

async function loadWaitState() {
  const host = document.getElementById('wait-banner');
  if (!host) return;
  const r = await fetch('/api/me/wait');
  if (!r.ok) { host.style.display = 'none'; return; }
  const w = await r.json();
  if (!w.waiting) { host.style.display = 'none'; return; }
  host.style.display = '';
  if (w.reason === 'no_running_league') {
    host.innerHTML =
      '<div class="head">Your team is on the bench</div>' +
      'No league is running right now. Your team will be seated the moment the next season kicks off.';
    return;
  }
  if (w.reason === 'next_season') {
    const eta = fmtEta(w.eta_seconds || 0);
    const ahead = w.ahead_in_queue || 0;
    const queueMsg = ahead === 0
      ? 'You\\'re first in the queue — guaranteed a seat in the next season\\'s bottom league.'
      : ahead + ' real player' + (ahead === 1 ? '' : 's') + ' ahead of you in the queue.';
    host.innerHTML =
      '<div class="head">Waiting for next league</div>' +
      'Your team will join the next league when the current one finishes — estimated <span class="eta">' + eta + '</span> from now.' +
      '<div class="meta">' + queueMsg + ' New signups take bot slots first, so if the bottom league has room you\\'ll take a bot\\'s seat; otherwise you wait one cycle and come in at the NEXT season.</div>';
    return;
  }
  host.innerHTML = '<div class="head">Waiting</div>' + 'Your team is between seasons.';
}

async function loadSchedule() {
  const sch = await fetch('/api/team/' + currentTeam.id + '/schedule').then(r => r.ok ? r.json() : null);
  const section = document.getElementById('schedule-section');
  const host = document.getElementById('schedule');
  if (!sch || (!sch.upcoming.length && !sch.recent.length)) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  const rowHtml = (f, isUpcoming) => {
    const weHome = f.home_team_id === currentTeam.id;
    const homeCls = weHome ? ' us' : '';
    const awayCls = !weHome ? ' us' : '';
    const homeId = f.home_team_id;
    const awayId = f.away_team_id;
    // Wrap each team name in a link to its profile, except OUR team — that's
    // already this page. The opposing-team link is the colorblind-safe path
    // to scouting them after a fixture surprises us.
    const teamCell = (cls, id, name) => id === currentTeam.id
      ? '<span class="' + cls.trim() + '">' + esc(name) + '</span>'
      : '<a class="' + cls.trim() + ' sched-team-link" href="/team/' + id + '">' + esc(name) + '</a>';
    let score = '—';
    let scoreCls = '';
    let statusLabel, statusCls;
    if (isUpcoming) {
      statusLabel = f.status === 'running' ? 'live' : 'pending';
      statusCls = f.status === 'running' ? 'running' : '';
    } else {
      // Explicit win/draw/loss label so the row reads correctly without
      // relying on the green/red score color (colorblind-safe).
      score = f.home_score + '–' + f.away_score;
      if (f.winner_team_id === currentTeam.id) { scoreCls = 'win'; statusLabel = 'won'; statusCls = 'win'; }
      else if (f.winner_team_id == null) { scoreCls = 'draw'; statusLabel = 'drew'; statusCls = 'draw'; }
      else { scoreCls = 'loss'; statusLabel = 'lost'; statusCls = 'loss'; }
    }
    const fighterCell = (cls, name) => name
      ? '<div class="sched-fighter ' + cls + '">' + esc(name) + '</div>'
      : '';
    return '<div class="schedule-row">' +
      '<div class="sched-round">L' + f.tier + ' · R' + f.round_num + '.' + f.slot_num + '</div>' +
      '<div class="sched-team">' + teamCell(homeCls, homeId, f.home_name) + '</div>' +
      '<div class="sched-vs">vs</div>' +
      '<div class="sched-team away">' + teamCell(awayCls, awayId, f.away_name) + '</div>' +
      '<div class="sched-score ' + scoreCls + '">' + score + '</div>' +
      '<div class="sched-status ' + statusCls + '">' + esc(statusLabel) + '</div>' +
      fighterCell('home', f.home_fighter) +
      fighterCell('away', f.away_fighter) +
    '</div>';
  };
  host.innerHTML =
    (sch.upcoming.length ? '<div style="color:#8b949e;font-size:11px;margin-bottom:4px">Upcoming</div>' + sch.upcoming.map(f => rowHtml(f, true)).join('') : '') +
    (sch.recent.length ? '<div style="color:#8b949e;font-size:11px;margin:8px 0 4px">Recent</div>' + sch.recent.map(f => rowHtml(f, false)).join('') : '');
}

function renderFighter(f) {
  const master = f.master_display_name || f.master_file_name || '—';
  const stam = Number(f.stamina || 0).toFixed(2);
  const right = f.slot === 'for_sale' && f.listing_price_cents != null
    ? '<div class="fr-stam" style="color:#f0ae3c;font-weight:600">' + fmtCents(f.listing_price_cents) + '</div>'
    : '<div class="fr-stam">stamina ' + stam + '</div>';
  const dragAttrs = f.slot === 'for_sale' ? '' : ' draggable="true"';
  const portraitSrc = f.master_file_name ? '/portrait/' + encodeURIComponent(f.master_file_name) + '.png' : '';
  const portrait = portraitSrc
    ? '<img class="fr-port" src="' + portraitSrc + '" alt="" onerror="this.style.visibility=\\'hidden\\'">'
    : '<div class="fr-port"></div>';
  return '<div class="fighter-row"' + dragAttrs + ' data-fid="' + f.id + '" data-slot="' + esc(f.slot) + '"' +
    ' ondragstart="dragStart(event,' + f.id + ')" ondragover="dragOver(event)"' +
    ' ondragenter="dragEnter(event)" ondragleave="dragLeave(event)"' +
    ' ondrop="dropOn(event,' + f.id + ')" ondragend="dragEnd(event)"' +
    ' onclick="maybeOpenEditor(event,' + f.id + ')">' +
    '<div class="fr-grip">⋮⋮</div>' +
    portrait +
    '<div class="fr-name">' + esc(f.display_name) + '</div>' +
    '<div class="fr-master">' + esc(master) + '</div>' +
    '<div class="fr-stats">' + f.matches_won + 'W · ' + f.matches_lost + 'L · ' + f.matches_drawn + 'D</div>' +
    right +
    '<div class="fr-edit">edit →</div>' +
  '</div>';
}

function renderSection(id, rows) {
  document.getElementById(id).innerHTML = rows.length
    ? rows.map(renderFighter).join('')
    : '<div class="roster-empty">(none)</div>';
}

function renderNotices() {
  const host = document.getElementById('notices-host');
  if (!host) return;
  const notices = (currentTeam && currentTeam.notices) || [];
  if (!notices.length) { host.innerHTML = ''; return; }
  host.innerHTML = notices.map((n) => {
    if (n.kind === 'auto_replenish') {
      const added = (n.body && n.body.added) || [];
      const items = added.map((a) =>
        '<li>' + esc(a.master_display_name || a.master_file_name || a.display_name) + '</li>'
      ).join('');
      return '<div class="notice">' +
        '<button class="dismiss" title="Dismiss" onclick="dismissNoticeUI(' + n.id + ')">×</button>' +
        '<div class="head">Roster auto-refilled</div>' +
        'Your active roster was below 5 fighters when a fixture was due, so we drew the oldest unclaimed masters from the market to bring you back up to a full team:' +
        '<ul>' + items + '</ul>' +
      '</div>';
    }
    return '';
  }).join('');
}

async function dismissNoticeUI(id) {
  await fetch('/api/me/team/notices/' + id + '/dismiss', { method: 'POST' });
  if (currentTeam && currentTeam.notices) {
    currentTeam.notices = currentTeam.notices.filter((n) => n.id !== id);
  }
  renderNotices();
}

function renderTeam() {
  const t = currentTeam;
  renderNotices();
  document.getElementById('team-name').value = t.name || '';
  const ar = document.getElementById('auto-rotate');
  if (ar) ar.checked = !!t.auto_rotate;
  const slider = document.getElementById('rotate-threshold');
  const stamChk = document.getElementById('rotate-on-stamina');
  const lossChk = document.getElementById('rotate-on-losses');
  const streakIn = document.getElementById('rotate-loss-streak');
  if (slider) {
    slider.value = (t.rotation_threshold != null ? t.rotation_threshold : 0.85).toFixed(2);
    updateThresholdLabel();
  }
  if (stamChk) stamChk.checked = t.rotate_on_stamina == null ? true : !!t.rotate_on_stamina;
  if (lossChk) lossChk.checked = !!t.rotate_on_losses;
  if (streakIn) streakIn.value = t.rotation_loss_streak || 3;
  // Mode picker. 'fixed' (legacy) maps to 'stamina' for radio purposes —
  // it just means conditional with no conditions, which is equivalent.
  const mode = t.rotation_mode === 'sequential_active' || t.rotation_mode === 'sequential_full'
    ? t.rotation_mode : 'stamina';
  const modeRadio = document.querySelector('input[name="rotation-mode"][value="' + mode + '"]');
  if (modeRadio) modeRadio.checked = true;
  applyModeUI(mode);
  const cfg = document.getElementById('rotate-config');
  if (cfg) cfg.classList.toggle('disabled', !t.auto_rotate);
  const active = t.fighters.filter(f => f.slot === 'active').sort((a,b) => a.priority - b.priority || a.id - b.id);
  const bench  = t.fighters.filter(f => f.slot === 'bench' ).sort((a,b) => a.id - b.id);
  const forSale = t.fighters.filter(f => f.slot === 'for_sale').sort((a,b) => a.id - b.id);
  renderSection('active-slots', active);
  renderSection('bench-slots', bench);
  if (forSale.length) {
    document.getElementById('forsale-section').style.display = '';
    renderSection('forsale-slots', forSale);
  }
}
function applyModeUI(mode) {
  const isSeq = mode === 'sequential_active' || mode === 'sequential_full';
  const stamRow = document.getElementById('cond-row-stamina');
  const lossRow = document.getElementById('cond-row-losses');
  const stamChk = document.getElementById('rotate-on-stamina');
  const lossChk = document.getElementById('rotate-on-losses');
  if (stamRow) stamRow.style.opacity = isSeq ? '0.4' : '1';
  if (lossRow) lossRow.style.opacity = isSeq ? '0.4' : '1';
  if (stamChk) stamChk.disabled = isSeq;
  if (lossChk) lossChk.disabled = isSeq;
  const tips = isSeq ? 'Sequential rotation overrides stamina/loss-streak.' : '';
  if (stamRow) stamRow.title = tips;
  if (lossRow) lossRow.title = tips;
  const hint = document.getElementById('rotate-hint');
  if (hint) {
    if (mode === 'sequential_active') {
      hint.innerHTML = 'Sequential mode: cycles through your <b>5 active</b> fighters one fixture at a time, in priority order. Stamina &amp; loss-streak rules ignored.';
    } else if (mode === 'sequential_full') {
      hint.innerHTML = 'Sequential mode: cycles through your <b>active + bench</b> (up to 10) one fixture at a time. When a benched fighter\\'s turn comes up, they swap into active, demoting the lowest-priority active. Stamina &amp; loss-streak rules ignored.';
    } else {
      hint.innerHTML = 'Rotation is between fixtures only. The fielded fighter loses <b>0.20</b> stamina after their match; every other roster fighter on your team gains <b>0.25</b> while resting (capped at 1.00).';
    }
  }
}

function updateThresholdLabel() {
  const slider = document.getElementById('rotate-threshold');
  if (!slider) return;
  document.getElementById('rotate-threshold-val').textContent = Number(slider.value).toFixed(2);
}

async function saveRotation() {
  const on = document.getElementById('auto-rotate').checked;
  const modeEl = document.querySelector('input[name="rotation-mode"]:checked');
  const mode = modeEl ? modeEl.value : 'stamina';
  applyModeUI(mode);
  const stam = document.getElementById('rotate-on-stamina').checked;
  const loss = document.getElementById('rotate-on-losses').checked;
  const threshold = Number(document.getElementById('rotate-threshold').value);
  const streak = parseInt(document.getElementById('rotate-loss-streak').value, 10) || 3;
  document.getElementById('rotate-config').classList.toggle('disabled', !on);
  const msg = document.getElementById('rotate-msg');
  msg.className = 'msg'; msg.textContent = 'saving…';
  const active = currentTeam.fighters.filter(f => f.slot === 'active')
    .sort((a, b) => a.priority - b.priority || a.id - b.id).map(f => f.id);
  const bench = currentTeam.fighters.filter(f => f.slot === 'bench')
    .sort((a, b) => a.id - b.id).map(f => f.id);
  const priority = {};
  active.forEach((id, i) => (priority[id] = i));
  const r = await fetch('/api/team/' + currentTeam.id + '/lineup', {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      active, bench, priority,
      auto_rotate: on,
      rotate_on_stamina: stam, rotate_on_losses: loss,
      rotation_threshold: threshold, rotation_loss_streak: streak,
      rotation_mode: mode,
    }),
  });
  if (r.ok) {
    currentTeam.auto_rotate = on ? 1 : 0;
    currentTeam.rotate_on_stamina = stam ? 1 : 0;
    currentTeam.rotate_on_losses = loss ? 1 : 0;
    currentTeam.rotation_threshold = threshold;
    currentTeam.rotation_loss_streak = streak;
    currentTeam.rotation_mode = mode;
    msg.className = 'msg ok';
    let summary;
    if (mode === 'sequential_active') summary = 'sequential · active 5';
    else if (mode === 'sequential_full') summary = 'sequential · active + bench';
    else {
      const rules = [];
      if (stam) rules.push('stamina<' + threshold.toFixed(2));
      if (loss) rules.push(streak + 'L streak');
      summary = rules.length ? rules.join(' or ') : 'no rules';
    }
    msg.textContent = on ? 'saved · ' + summary : 'auto-rotate off';
  } else {
    const body = await r.json().catch(() => ({}));
    msg.className = 'msg err'; msg.textContent = body.error || 'error';
  }
  setTimeout(() => { msg.textContent = ''; }, 2500);
}

async function saveTeamName() {
  const name = document.getElementById('team-name').value.trim();
  const msg = document.getElementById('team-name-msg');
  msg.className = 'msg'; msg.textContent = '…';
  const r = await fetch('/api/team/' + currentTeam.id + '/name', {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name}),
  });
  const body = await r.json();
  if (r.ok) {
    currentTeam.name = body.name;
    msg.className = 'msg ok'; msg.textContent = 'saved';
  } else {
    msg.className = 'msg err'; msg.textContent = body.error || 'error';
  }
  setTimeout(() => { msg.textContent = ''; }, 2200);
}

// ---------- Drag-drop lineup reorder ----------

let dragId = null;

function dragStart(e, id) {
  dragId = id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // needed for Firefox to actually fire drop
  e.dataTransfer.setData('text/plain', String(id));
}
function dragOver(e) {
  if (dragId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}
function dragEnter(e) {
  if (dragId == null) return;
  const row = e.currentTarget;
  if (Number(row.dataset.fid) === dragId) return;
  row.classList.add('drop-target');
}
function dragLeave(e) {
  e.currentTarget.classList.remove('drop-target');
}
function dragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.fighter-row.drop-target').forEach(el => el.classList.remove('drop-target'));
  dragId = null;
}

function maybeOpenEditor(e, fighterId) {
  // If a drag-over highlight was left on this row, clear it.
  e.currentTarget.classList.remove('drop-target', 'dragging');
  // Only open editor on a plain click — not if the user just finished a drag.
  if (dragId != null) return;
  openEditor(fighterId);
}

async function dropOn(e, targetId) {
  e.preventDefault();
  const sourceId = dragId;
  dragId = null;
  document.querySelectorAll('.fighter-row.dragging, .fighter-row.drop-target')
    .forEach((el) => el.classList.remove('dragging', 'drop-target'));
  if (sourceId == null || sourceId === targetId) return;

  const src = currentTeam.fighters.find(f => f.id === sourceId);
  const tgt = currentTeam.fighters.find(f => f.id === targetId);
  if (!src || !tgt) return;
  if (src.slot === 'for_sale' || tgt.slot === 'for_sale') return;

  // Swap slots + priorities. Keeps "exactly 5 active, 0..5 bench" because
  // we're only ever swapping one-for-one.
  const srcSlot = src.slot;
  const srcPri = src.priority;
  src.slot = tgt.slot;
  src.priority = tgt.priority;
  tgt.slot = srcSlot;
  tgt.priority = srcPri;

  renderTeam();
  await saveLineup();
}

async function saveLineup() {
  const active = currentTeam.fighters
    .filter(f => f.slot === 'active')
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .map(f => f.id);
  const bench = currentTeam.fighters
    .filter(f => f.slot === 'bench')
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .map(f => f.id);
  const priority = {};
  active.forEach((id, i) => (priority[id] = i));
  const r = await fetch('/api/team/' + currentTeam.id + '/lineup', {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ active, bench, priority, auto_rotate: currentTeam.auto_rotate ? true : false }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    console.error('lineup save failed', body);
    // reload to resync with server state
    await loadTeam();
  }
}

async function openEditor(fighterId) {
  const f = currentTeam.fighters.find(x => x.id === fighterId);
  if (!f) return;
  const portraitSrc = f.master_file_name ? '/portrait/' + encodeURIComponent(f.master_file_name) + '.png' : '';
  document.getElementById('edit-body').innerHTML =
    '<div style="display:flex;gap:14px;align-items:center;margin-bottom:10px">' +
      (portraitSrc
        ? '<img src="' + portraitSrc + '" style="width:72px;height:72px;image-rendering:pixelated;background:#0d1117;border:1px solid #30363d;border-radius:6px;object-fit:contain" onerror="this.style.visibility=\\'hidden\\'">'
        : '') +
      '<div style="flex:1"><h3 style="margin:0">' + esc(f.display_name) + '</h3>' +
      '<div class="sub">Character: ' + esc(f.master_display_name || f.master_file_name) + ' · ' + esc(f.slot) + ' · priority ' + f.priority + '</div></div>' +
    '</div>' +
    '<div class="stats">' +
      '<div class="stat"><div class="v">' + f.matches_won + '</div><div class="l">Wins</div></div>' +
      '<div class="stat"><div class="v">' + f.matches_lost + '</div><div class="l">Losses</div></div>' +
      '<div class="stat"><div class="v">' + f.matches_drawn + '</div><div class="l">Draws</div></div>' +
      '<div class="stat"><div class="v">' + Number(f.stamina || 0).toFixed(2) + '</div><div class="l">Stamina</div></div>' +
    '</div>' +
    '<div class="row">' +
      '<label>Name</label>' +
      '<input type="text" id="edit-name" value="' + esc(f.display_name) + '" maxlength="40">' +
      '<button onclick="saveFighterName(' + f.id + ')">Rename</button>' +
      '<span class="msg" id="edit-name-msg"></span>' +
    '</div>' +
    '<div id="edit-sell" class="row"></div>' +
    '<div class="ai-hdr">AI &middot; loading…</div>' +
    '<textarea id="edit-cmd" spellcheck="false" disabled>loading…</textarea>' +
    '<div class="row" style="margin-top:10px">' +
      '<button id="edit-ai-save" onclick="saveFighterAI(' + f.id + ')" disabled>Save AI</button>' +
      '<span class="msg" id="edit-ai-msg"></span>' +
    '</div>' +
    '<div class="ai-hdr">Recent matches</div>' +
    '<div id="edit-history" class="history-list"><div style="color:#6e7681;font-size:11px">loading…</div></div>';
  document.getElementById('edit-bg').classList.add('open');
  await renderSellSection(f);
  loadFighterHistory(f.id);

  const r = await fetch('/api/owned-fighter/' + fighterId + '/ai');
  if (!r.ok) {
    document.querySelector('.ai-hdr').textContent = 'AI · unavailable';
    return;
  }
  const ai = await r.json();
  document.querySelector('.ai-hdr').textContent =
    'AI &middot; ' + (ai.source === 'override' ? 'your override v' + ai.version : 'stock character');
  const ta = document.getElementById('edit-cmd');
  ta.value = ai.cmd_text;
  ta.disabled = false;
  document.getElementById('edit-ai-save').disabled = false;
}

function closeEditor() {
  document.getElementById('edit-bg').classList.remove('open');
}

async function saveFighterName(id) {
  const name = document.getElementById('edit-name').value.trim();
  const msg = document.getElementById('edit-name-msg');
  msg.className = 'msg'; msg.textContent = '…';
  const r = await fetch('/api/owned-fighter/' + id + '/name', {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name}),
  });
  const body = await r.json();
  if (r.ok) {
    const f = currentTeam.fighters.find(x => x.id === id);
    if (f) f.display_name = body.name;
    renderTeam();
    msg.className = 'msg ok'; msg.textContent = 'saved';
    // also update the title in the modal header
    document.querySelector('#edit-body h3').textContent = body.name;
  } else {
    msg.className = 'msg err'; msg.textContent = body.error || 'error';
  }
  setTimeout(() => { msg.textContent = ''; }, 2200);
}

async function renderSellSection(f) {
  const host = document.getElementById('edit-sell');
  if (!host) return;
  if (f.slot === 'active') {
    host.innerHTML = '<label>Market</label><span style="color:#6e7681;font-size:12px">Bench this fighter first to list or release.</span>';
    return;
  }
  const releaseBtn = '<button onclick="releaseFighter(' + f.id + ')" style="background:transparent;color:#f85149;border:1px solid #f85149">Release</button>';
  if (f.slot === 'for_sale') {
    const price = Number(f.listing_price_cents || 0);
    host.innerHTML =
      '<label>Market</label>' +
      '<span style="font-size:13px">Listed at <b>' + fmtCents(price) + '</b></span>' +
      '<button onclick="unlistFighter(' + f.id + ')">Unlist</button>' +
      releaseBtn +
      '<span class="msg" id="edit-sell-msg"></span>';
    return;
  }
  // bench
  host.innerHTML =
    '<label>Market</label>' +
    '<span style="color:#8b949e;font-size:12px">loading suggested price…</span>';
  const r = await fetch('/api/owned-fighter/' + f.id + '/suggested-price');
  const suggested = r.ok ? (await r.json()).price_cents : 0;
  host.innerHTML =
    '<label>Market</label>' +
    '<input type="number" id="edit-price" min="0" step="1" value="' + suggested + '" style="max-width:120px">' +
    '<span style="color:#8b949e;font-size:11px">¢ · suggested ' + fmtCents(suggested) + '</span>' +
    '<button onclick="listFighter(' + f.id + ')">List for sale</button>' +
    releaseBtn +
    '<span class="msg" id="edit-sell-msg"></span>';
}

async function releaseFighter(id) {
  if (!confirm('Release this fighter to the market pool? You won\\'t get any money back. The master becomes available to other players.')) return;
  const msg = document.getElementById('edit-sell-msg');
  msg.className = 'msg'; msg.textContent = '…';
  const r = await fetch('/api/owned-fighter/' + id + '/release', { method: 'POST' });
  const body = await r.json();
  if (r.ok) {
    // Drop it from local state and close the editor.
    currentTeam.fighters = currentTeam.fighters.filter(x => x.id !== id);
    renderTeam();
    closeEditor();
  } else {
    msg.className = 'msg err'; msg.textContent = body.error || 'error';
  }
}

async function listFighter(id) {
  const price = parseInt(document.getElementById('edit-price').value, 10);
  const msg = document.getElementById('edit-sell-msg');
  msg.className = 'msg'; msg.textContent = '…';
  const r = await fetch('/api/owned-fighter/' + id + '/list-for-sale', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ price_cents: price }),
  });
  const body = await r.json();
  if (r.ok) {
    msg.className = 'msg ok'; msg.textContent = 'listed at ' + fmtCents(body.price_cents);
    const f = currentTeam.fighters.find(x => x.id === id);
    if (f) { f.slot = 'for_sale'; f.listing_price_cents = body.price_cents; }
    renderTeam();
    renderSellSection(f);
  } else {
    msg.className = 'msg err'; msg.textContent = body.error || 'error';
  }
}

async function unlistFighter(id) {
  const msg = document.getElementById('edit-sell-msg');
  msg.className = 'msg'; msg.textContent = '…';
  const r = await fetch('/api/owned-fighter/' + id + '/unlist', { method: 'POST' });
  const body = await r.json();
  if (r.ok) {
    const f = currentTeam.fighters.find(x => x.id === id);
    if (f) { f.slot = 'bench'; f.listing_price_cents = null; }
    renderTeam();
    renderSellSection(f);
  } else {
    msg.className = 'msg err'; msg.textContent = body.error || 'error';
  }
}

async function loadFighterHistory(fighterId) {
  const host = document.getElementById('edit-history');
  if (!host) return;
  const r = await fetch('/api/owned-fighter/' + fighterId + '/history');
  if (!r.ok) { host.innerHTML = '<div style="color:#6e7681;font-size:11px">(unavailable)</div>'; return; }
  const rows = await r.json();
  if (!rows.length) {
    host.innerHTML = '<div style="color:#6e7681;font-size:11px">No matches yet.</div>';
    return;
  }
  host.innerHTML = rows.map(m => {
    const me = m.side; // 'home' or 'away'
    const won = m.winner === me;
    const lost = m.winner !== 'draw' && m.winner !== me;
    const resCls = won ? 'res-w' : lost ? 'res-l' : 'res-d';
    const res = won ? 'W' : lost ? 'L' : 'D';
    const rounds = (me === 'home' ? m.home_rounds : m.away_rounds) + '-' + (me === 'home' ? m.away_rounds : m.home_rounds);
    return '<div class="history-row">' +
      '<div class="' + resCls + '">' + res + '</div>' +
      '<div class="opp">vs ' + esc(m.opponent) + ' <span style="color:#6e7681">(' + esc(m.opponent_team) + ')</span></div>' +
      '<div class="rounds">' + rounds + '</div>' +
    '</div>';
  }).join('');
}

async function saveFighterAI(id) {
  const cmd_text = document.getElementById('edit-cmd').value;
  const msg = document.getElementById('edit-ai-msg');
  msg.className = 'msg'; msg.textContent = 'validating…';
  const r = await fetch('/api/owned-fighter/' + id + '/ai', {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({cmd_text}),
  });
  const body = await r.json();
  if (r.ok) {
    msg.className = 'msg ok'; msg.textContent = 'saved v' + body.version;
    document.querySelector('.ai-hdr').textContent = 'AI · your override v' + body.version;
  } else {
    msg.className = 'msg err';
    msg.textContent = (body.error || 'error') + (body.reason ? ' (' + body.reason + ')' : '');
  }
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEditor(); });

async function loadImports() {
  const r = await fetch('/api/me/imports');
  if (!r.ok) return;
  const rows = await r.json();
  const host = document.getElementById('imports-list');
  if (rows.length === 0) { host.innerHTML = ''; return; }
  host.innerHTML = rows.map(r => {
    const cls = r.status === 'approved' ? 'status-approved' : r.status === 'rejected' ? 'status-rejected' : 'status-other';
    const label = esc(r.file_name || r.original_filename || '(upload)');
    const reason = r.reject_reason ? ' — ' + esc(r.reject_reason) : '';
    return '<div class="import-row-rec">' +
      '<div>' + label + '</div>' +
      '<div class="' + cls + '">' + esc(r.status) + '</div>' +
      '<div style="color:#8b949e">' + esc(r.created_at) + reason + '</div>' +
    '</div>';
  }).join('');
}

async function doImport() {
  const file = document.getElementById('import-file').files[0];
  const msg = document.getElementById('import-msg');
  const btn = document.getElementById('import-btn');
  if (!file) { msg.className = 'msg err'; msg.textContent = 'Pick a .zip first.'; return; }
  msg.className = 'msg'; msg.textContent = 'uploading + testing (can take ~10s)…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/import/char', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-Filename': file.name },
      body: file,
    });
    const body = await r.json();
    if (r.ok && body.ok) {
      msg.className = 'msg ok';
      msg.textContent = 'Imported "' + body.file_name + '" (fighter #' + body.fighter_id + ').';
    } else {
      msg.className = 'msg err';
      msg.textContent = 'Rejected: ' + (body.reason || body.error || 'unknown');
    }
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = 'Upload failed: ' + e.message;
  } finally {
    btn.disabled = false;
    loadImports();
  }
}

loadImports();
</script>
</body></html>`;

const LEAGUES_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Leagues · MugenBattle</title>
<style>${COMMON_CSS}
  .workers { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
  .worker { background: #161b22; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; }
  .worker .stream { background: #000; aspect-ratio: 4 / 3; }
  .worker .stream img { width: 100%; height: 100%; object-fit: contain; display: block; image-rendering: pixelated; }
  .worker .idle { display: flex; align-items: center; justify-content: center; height: 100%; color: #6e7681; font-size: 13px; }
  .worker .overlay { padding: 10px 14px; }
  .worker .hdr { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .worker .lname { font-size: 13px; font-weight: 600; }
  .worker .tier { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
  .worker .matchup { font-size: 14px; margin: 2px 0 6px; color: #c9d1d9; }
  .worker .matchup .score { color: #f0ae3c; font-variant-numeric: tabular-nums; font-weight: 600; margin: 0 8px; }
  .worker .matchup a { color: inherit; text-decoration: none; }
  .worker .matchup a:hover { color: #58a6ff; text-decoration: underline; }
  .worker .meta { color: #8b949e; font-size: 11px; display: flex; gap: 12px; flex-wrap: wrap; }
  .worker .fighters { font-size: 12px; color: #c9d1d9; margin: 4px 0 6px; }
  .worker .fighters .vs { color: #6e7681; margin: 0 6px; }
  .worker .fighters .name-link { cursor: pointer; }
  .worker .fighters .name-link:hover { color: #58a6ff; text-decoration: underline; }
  .worker .wid { color: #6e7681; font-size: 10px; text-transform: uppercase; }
  .empty-state { text-align: center; padding: 40px 20px; color: #6e7681; background: #161b22; border: 1px dashed #30363d; border-radius: 10px; }
</style></head>
<body style="position:relative">
${AUTH_BAR_HTML}
<h1>📺 Live Leagues</h1>
<nav>
  <a href="/">Live</a>
  <a href="/leagues" class="active">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market">Market</a>
  <a href="/exhibition">Exhibition</a>
  <a href="/trades">Trades</a>
  <a href="/tournaments">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>
<div id="workers"></div>

<div class="modal-bg" id="modal-bg" onclick="if(event.target.id==='modal-bg')closeModal()">
  <div class="modal modal-shell">
    <div class="close" onclick="closeModal()">×</div>
    <div id="modal-body"></div>
  </div>
</div>

<script>
function esc(s){return String(s==null?'':s).replace(/[<>&'"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&#39;','"':'&quot;'}[c]))}
let followedMastersCache = null;
async function loadFollowedMasters() {
  if (followedMastersCache) return followedMastersCache;
  try {
    const r = await fetch('/api/follow');
    if (!r.ok) { followedMastersCache = new Set(); return followedMastersCache; }
    const j = await r.json();
    followedMastersCache = new Set(j.masters || []);
  } catch { followedMastersCache = new Set(); }
  return followedMastersCache;
}
async function toggleFollowMaster(masterId, btn) {
  const set = await loadFollowedMasters();
  const isOn = set.has(masterId);
  if (isOn) {
    await fetch('/api/follow/master/' + masterId, { method: 'DELETE' });
    set.delete(masterId);
    btn.textContent = '☆'; btn.title = 'Follow'; btn.style.color = '#8b949e';
  } else {
    const r = await fetch('/api/follow', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ kind: 'master', id: masterId }) });
    if (r.status === 401) { alert('Sign in to follow fighters.'); return; }
    set.add(masterId);
    btn.textContent = '★'; btn.title = 'Unfollow'; btn.style.color = '#f0ae3c';
  }
}
async function openProfile(fileName) {
  const r = await fetch('/api/fighter/' + encodeURIComponent(fileName));
  if (!r.ok) return;
  const f = await r.json();
  const followed = await loadFollowedMasters();
  const isFollowed = followed.has(f.id);
  const starGlyph = isFollowed ? '★' : '☆';
  const starColor = isFollowed ? '#f0ae3c' : '#8b949e';
  const starTip = isFollowed ? 'Unfollow' : 'Follow';
  const recent = (f.recent || []).map((m) => {
    const winLose = m.victor === f.display_name || m.victor_file === f.file_name ? 'W' : (m.victor ? 'L' : 'D');
    const isF1 = (m.f1 === (f.display_name || f.file_name)) || (m.f1_file === f.file_name);
    const opp = isF1 ? m.f2 : m.f1;
    const oppFile = isF1 ? m.f2_file : m.f1_file;
    const oppCell = oppFile
      ? 'vs <span style="cursor:pointer;color:#58a6ff;text-decoration:underline" onclick=\\'openProfile(' + JSON.stringify(oppFile) + ')\\'>' + esc(opp || '?') + '</span>'
      : 'vs ' + esc(opp || '?');
    return '<tr><td>' + winLose + '</td><td>' + oppCell + '</td><td style="color:#8b949e">' + esc(m.stage || '') + '</td></tr>';
  }).join('');
  const reasonLabel = (r) => {
    if (!r) return '';
    if (r === 'created') return 'starter roster';
    if (r === 'bought_from_market') return 'bought from pool';
    if (r === 'bought_from_user') return 'bought from owner';
    if (r === 'auto_replenish') return 'auto-replenished';
    if (r === 'replaced_extra_kfm') return 'replaced training dummy';
    if (r === 'boot_sweep') return 'boot recovery';
    if (r.startsWith('kfm_replacement:repeated_crash')) return 'system-replaced (crash)';
    if (r.startsWith('kfm_replacement:')) return 'system-replaced';
    return r;
  };
  const stateLabel = (s) => {
    if (s === 'current') return '<span style="color:#3fb950">current</span>';
    if (s === 'released') return '<span style="color:#d29922">released</span>';
    if (s === 'sold') return '<span style="color:#58a6ff">sold</span>';
    return '<span style="color:#6e7681">' + s + '</span>';
  };
  const ownersHtml = (f.owners && f.owners.length)
    ? '<h2 style="margin-top:16px;font-size:12px;text-transform:uppercase;color:#8b949e">Owner history</h2><table>' +
      f.owners.map(o => {
        const bot = o.owner_is_bot ? ' <span style="color:#8b949e;font-size:10px;background:#21262d;border-radius:3px;padding:1px 4px">BOT</span>' : '';
        return '<tr><td style="white-space:nowrap"><a href="/team/' + o.team_id + '">' + esc(o.team_name) + '</a> <span style="color:#8b949e">@' + esc(o.owner_username) + '</span>' + bot + '</td><td style="color:#8b949e;font-size:11px">' + esc(o.joined_at || '') + '</td><td>' + stateLabel(o.state) + '</td><td style="color:#6e7681;font-size:11px">' + esc(reasonLabel(o.reason)) + '</td></tr>';
      }).join('') + '</table>'
    : '';
  document.getElementById('modal-body').innerHTML =
    '<div class="head">' +
      '<img class="portrait" src="/portrait/' + encodeURIComponent(f.file_name) + '.png" onerror="this.style.visibility=\\'hidden\\'">' +
      '<div style="flex:1"><h3 style="display:flex;align-items:center;gap:10px;margin:0">' +
      '<span>' + esc(f.display_name || f.file_name) + '</span>' +
      '<button id="modal-star" title="' + starTip + '" style="background:none;border:0;font-size:22px;cursor:pointer;color:' + starColor + ';padding:0;line-height:1">' + starGlyph + '</button>' +
      '</h3>' +
      '<div class="sub">' + esc(f.author || 'unknown author') + '</div></div></div>' +
    '<div class="stats">' +
      '<div class="stat"><div class="v">' + f.matches_won + '</div><div class="l">Wins</div></div>' +
      '<div class="stat"><div class="v">' + f.matches_lost + '</div><div class="l">Losses</div></div>' +
      '<div class="stat"><div class="v">' + f.matches_drawn + '</div><div class="l">Draws</div></div>' +
      '<div class="stat"><div class="v">' + f.win_rate + '%</div><div class="l">Win rate</div></div></div>' +
    '<div class="field"><b>File name:</b> ' + esc(f.file_name) + '</div>' +
    (f.author ? '<div class="field"><b>Author:</b> ' + esc(f.author) + '</div>' : '') +
    (recent ? '<h2 style="margin-top:16px;font-size:12px;text-transform:uppercase;color:#8b949e">Recent fights</h2><table>' + recent + '</table>' : '') + tourneyWinsHtml + ownersHtml;
  const sb = document.getElementById('modal-star');
  if (sb) sb.onclick = () => toggleFollowMaster(f.id, sb);
  document.getElementById('modal-bg').classList.add('open');
}
function closeModal() { document.getElementById('modal-bg').classList.remove('open'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
function overlayHtml(w) {
  const ctx = w.context;
  if (!ctx || !ctx.fixture) {
    const msg = ctx && ctx.league
      ? 'Between fixtures (' + esc(ctx.league.name) + ')'
      : w.status === 'idle' ? 'Waiting for a league…' : 'Starting up…';
    return '<div class="meta">' + esc(msg) + '</div>';
  }
  const f = ctx.fixture;
  // Build clickable spans for fighter names (open profile modal) and team
  // names (link to /team/<id>). Fall back to plain text when the underlying
  // file_name / team_id isn't available.
  const fighterTag = (display, file) => {
    if (!display) return '';
    if (!file) return esc(display);
    // Single-quoted onclick + JSON.stringify (which uses double quotes
    // internally) so apostrophes/backslashes in file names survive both
    // HTML attribute parsing and JS evaluation.
    return '<span class="name-link" onclick=\\'openProfile(' + JSON.stringify(file) + ')\\'>' + esc(display) + '</span>';
  };
  const teamTag = (name, id) => id
    ? '<a href="/team/' + id + '">' + esc(name) + '</a>'
    : esc(name);
  const fighterLine = (f.home_fighter && f.away_fighter)
    ? '<div class="fighters">' +
        fighterTag(f.home_fighter, f.home_master) +
        ' <span class="vs">vs</span> ' +
        fighterTag(f.away_fighter, f.away_master) +
      '</div>'
    : '';
  return (
    '<div class="hdr">' +
      '<span class="lname">' + esc(ctx.league.name) + '</span>' +
      '<span class="tier">League ' + f.division.tier + '</span>' +
    '</div>' +
    '<div class="matchup">' +
      teamTag(f.home_team, f.home_team_id) +
      '<span class="score">' + f.home_rounds + ' – ' + f.away_rounds + '</span>' +
      teamTag(f.away_team, f.away_team_id) +
    '</div>' +
    fighterLine +
    '<div class="meta">' +
      '<span>Round ' + f.round + '</span>' +
      (f.stage ? '<span>Stage: ' + esc(f.stage) + '</span>' : '') +
    '</div>'
  );
}

/**
 * Tiles are built ONCE per worker and preserved across ticks — only the
 * overlay DIV's innerHTML updates on each poll. Rebuilding the <img> tag
 * every tick would force the browser to reconnect to the MJPEG stream and
 * flicker to black between frames.
 */
function render(workers) {
  const root = document.getElementById('workers');
  if (!workers.length) {
    root.innerHTML = '<div class="empty-state">No workers running.</div>';
    return;
  }
  const running = workers.filter(w => w.status !== 'stopped');
  root.className = 'workers';
  for (const w of running) {
    let tile = document.getElementById('tile-' + w.workerId);
    if (!tile) {
      tile = document.createElement('div');
      tile.id = 'tile-' + w.workerId;
      tile.className = 'worker';
      tile.innerHTML =
        '<div class="stream"><img src="/stream/' + w.workerId + '" alt=""></div>' +
        '<div class="overlay" id="overlay-' + w.workerId + '"></div>';
      root.appendChild(tile);
    }
    document.getElementById('overlay-' + w.workerId).innerHTML = overlayHtml(w);
  }
  // Drop tiles for workers that disappeared.
  const ids = new Set(running.map(w => 'tile-' + w.workerId));
  for (const tile of Array.from(root.children)) {
    if (tile.id && !ids.has(tile.id)) tile.remove();
  }
}
async function tick() {
  try {
    const r = await fetch('/api/workers');
    render(await r.json());
  } catch (e) { console.error(e); }
}
tick();
setInterval(tick, 2000);
</script>
${AUTH_MODAL_HTML}
${AUTH_JS}
</body></html>`;

// Classic tournament UI — kept intact for a future championship mode.
// Served at /tournament. The / route uses the newer tier-tabbed Live page
// defined further down.
const TOURNAMENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MugenBattle Tournament</title>
<style>${COMMON_CSS}
  .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
  .sidebar { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
  .stream-row { display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 16px; align-items: start; }
  @media (max-width: 1100px) { .stream-row { grid-template-columns: 1fr; } }
  .stream-wrap { max-width: 1280px; margin: 0 auto; }
  .stream { background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 4 / 3; }
  .stream img { width: 100%; height: 100%; object-fit: contain; display: block; image-rendering: pixelated; }
  .fighter-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; }
  .fighter-card.empty { opacity: 0.3; }
  .fighter-card .fc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .fighter-card .fc-portrait { width: 56px; height: 56px; background: #0d1117; border-radius: 6px; image-rendering: pixelated; object-fit: contain; border: 1px solid #30363d; }
  .fighter-card .fc-name { font-size: 14px; font-weight: 600; line-height: 1.2; cursor: pointer; }
  .fighter-card .fc-name:hover { color: #58a6ff; }
  .fighter-card .fc-author { color: #8b949e; font-size: 11px; }
  .fighter-card .fc-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 10px; font-size: 11px; }
  .fighter-card .fc-stat { text-align: center; background: #0d1117; padding: 6px 2px; border-radius: 4px; }
  .fighter-card .fc-stat .v { font-size: 16px; font-weight: 600; color: #c9d1d9; }
  .fighter-card .fc-stat .l { color: #8b949e; font-size: 9px; text-transform: uppercase; }
  .fighter-card h3 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: #8b949e; }
  .fighter-card table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .fighter-card td { padding: 2px 4px; border-bottom: 1px solid #21262d; }
  .fighter-card .res-w { color: #3fb950; font-weight: 600; }
  .fighter-card .res-l { color: #f85149; font-weight: 600; }
  .fighter-card .res-d { color: #8b949e; }
  .info { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-top: 10px; font-size: 14px; color: #c9d1d9; flex-wrap: wrap; }
  .info .match strong { color: #f0ae3c; }
  .info .tourney { color: #8b949e; font-size: 12px; }
  .bracket { font-size: 11px; }
  .bracket .round { margin-bottom: 8px; }
  .bracket .round-title { color: #8b949e; font-size: 10px; text-transform: uppercase; margin-bottom: 4px; }
  .match { padding: 2px 4px; }
  .match.decided { color: #8b949e; }
  .match.decided .winner { color: #c9d1d9; font-weight: 600; }
  .vs { color: #6e7681; }
  .name-link { cursor: pointer; }
  .name-link:hover { text-decoration: underline; color: #58a6ff; }
  .fs-trigger { float: right; font-size: 14px; cursor: pointer; color: #58a6ff; user-select: none; }
  .fs-trigger:hover { color: #c9d1d9; }
  .fs-modal { position: fixed; inset: 0; background: rgba(13,17,23,0.97); z-index: 100; padding: 24px; overflow: auto; display: none; }
  .fs-modal.open { display: block; }
  .fs-modal .fs-close { position: fixed; top: 18px; right: 28px; cursor: pointer; font-size: 28px; color: #8b949e; z-index: 101; user-select: none; }
  .fs-modal .fs-close:hover { color: #c9d1d9; }
  .fs-modal h2 { margin: 0 0 16px; font-size: 18px; color: #c9d1d9; }
  .fs-modal svg { width: 100%; height: auto; display: block; }
  .matchup-matrix { border-collapse: collapse; margin-top: 14px; font-size: 11px; }
  .matchup-matrix th, .matchup-matrix td { padding: 4px 6px; border: 1px solid #21262d; text-align: center; }
  .matchup-matrix th.row-hdr { text-align: right; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .matchup-matrix .cell-w { color: #3fb950; }
  .matchup-matrix .cell-l { color: #f85149; }
  .matchup-matrix .cell-u { color: #6e7681; }
  .auth-bar { position: absolute; top: 16px; right: 16px; font-size: 13px; display: flex; align-items: center; gap: 10px; }
  .auth-bar button { background: #238636; color: white; border: 1px solid #2ea043; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .auth-bar button:hover { background: #2ea043; }
  .auth-bar .user-email { color: #8b949e; }
  .auth-bar .logout { background: transparent; color: #8b949e; border: 1px solid #30363d; }
  .auth-bar .logout:hover { background: #21262d; color: #c9d1d9; }
  .auth-form { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
  .auth-form input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; font-size: 14px; }
  .auth-form button { background: #238636; color: white; border: 1px solid #2ea043; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .auth-form .msg { font-size: 12px; min-height: 1em; }
  .auth-form .msg.err { color: #f85149; }
  .auth-form .msg.ok { color: #3fb950; }
  .see-all { display: block; text-align: right; font-size: 11px; color: #58a6ff; margin-top: 6px; }
</style>
</head>
<body style="position:relative">
${AUTH_BAR_HTML}
<h1>🥊 MugenBattle Live</h1>
<nav>
  <a href="/" class="active">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market">Market</a>
  <a href="/exhibition">Exhibition</a>
  <a href="/trades">Trades</a>
  <a href="/tournaments">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>
<div class="grid">
  <div class="stream-row">
    <div class="fighter-card empty" id="fc-1"></div>
    <div class="stream-wrap">
      <div class="stream"><img src="/stream" alt="live"></div>
      <div class="info">
        <div class="match" id="match-info">No active match</div>
        <div class="tourney" id="tourney-info"></div>
      </div>
    </div>
    <div class="fighter-card empty" id="fc-2"></div>
  </div>
  <div class="sidebar">
    <div class="panel" id="bracket-panel">
      <h2>Bracket <span class="fs-trigger" onclick="openFullscreen()" title="Full-screen view">⛶</span></h2>
      <div class="bracket" id="bracket">(no active tournament)</div>
    </div>
    <div class="panel">
      <h2>Leaderboard (top 15)</h2>
      <table id="leaderboard"><thead><tr><th>Fighter</th><th>W</th><th>L</th><th>D</th><th>Win%</th></tr></thead><tbody></tbody></table>
      <a class="see-all" href="/leaderboard">See all fighters →</a>
    </div>
    <div class="panel">
      <h2>Recent matches</h2>
      <table id="history"><tbody></tbody></table>
    </div>
  </div>
</div>
${MODAL_HTML}
${AUTH_MODAL_HTML}
${AUTH_JS}
<div class="fs-modal" id="fs-modal" onclick="if(event.target===this)closeFullscreen()">
  <div class="fs-close" onclick="closeFullscreen()">×</div>
  <h2 id="fs-title"></h2>
  <div id="fs-body"></div>
</div>
<script>
let lastTournament = null;
function openFullscreen() {
  if (!lastTournament) return;
  const t = lastTournament;
  document.getElementById('fs-title').textContent =
    \`Tournament #\${t.id} · \${t.name || ''}\${t.format === 'roundrobin' ? '  (Round-Robin, ' + t.size + ' fighters)' : '  (' + t.size + '-fighter bracket)'}\`;
  document.getElementById('fs-body').innerHTML = t.format === 'roundrobin' ? renderRoundRobinFs(t) : renderBracketSvg(t);
  document.getElementById('fs-modal').classList.add('open');
}
function closeFullscreen() { document.getElementById('fs-modal').classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFullscreen(); });

function renderBracketSvg(t) {
  const size = t.size;
  const rounds = Math.log2(size);
  const colW = 220, matchH = 60, matchW = 200, margin = 30, lineH = 22;
  const byRound = {};
  for (const m of t.matches) (byRound[m.round] ||= [])[m.match_index] = m;
  const totalH = (size / 2) * matchH + margin * 2;
  const totalW = rounds * colW + matchW + margin * 2;
  const labels = { 2: 'Final', 4: 'Semifinals', 8: 'Quarterfinals' };
  let svg = \`<svg viewBox="0 0 \${totalW} \${totalH}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui">\`;
  for (let r = 1; r <= rounds; r++) {
    const ms = byRound[r] || [];
    const stride = matchH * (2 ** (r - 1));
    const startY = stride / 2 - matchH / 2 + margin;
    const x = (r - 1) * colW + margin;
    // Round label at top
    const remaining = size / (2 ** (r - 1));
    const label = labels[remaining] || ('Round of ' + remaining);
    svg += \`<text x="\${x + matchW/2}" y="\${margin - 8}" fill="#8b949e" font-size="11" text-anchor="middle" text-transform="uppercase">\${esc(label)}</text>\`;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m) continue;
      const y = startY + i * stride;
      const f1Won = m.victor_id === m.fighter_one_id;
      const f2Won = m.victor_id === m.fighter_two_id;
      const decided = !!m.victor_id;
      svg += \`<rect x="\${x}" y="\${y}" width="\${matchW}" height="\${matchH}" fill="#161b22" stroke="#30363d" rx="4"/>\`;
      svg += \`<text x="\${x + 10}" y="\${y + lineH}" font-size="13" fill="\${f1Won ? '#f0ae3c' : (decided ? '#6e7681' : '#c9d1d9')}" font-weight="\${f1Won ? '700' : '400'}" style="cursor:pointer" onclick="closeFullscreen();openProfile('\${esc(m.f1_name).replace(/'/g, "\\\\'")}')">\${esc((m.f1_display || m.f1_name || '?').slice(0, 24))}</text>\`;
      svg += \`<line x1="\${x + 6}" y1="\${y + matchH/2}" x2="\${x + matchW - 6}" y2="\${y + matchH/2}" stroke="#21262d"/>\`;
      svg += \`<text x="\${x + 10}" y="\${y + matchH/2 + lineH}" font-size="13" fill="\${f2Won ? '#f0ae3c' : (decided ? '#6e7681' : '#c9d1d9')}" font-weight="\${f2Won ? '700' : '400'}" style="cursor:pointer" onclick="closeFullscreen();openProfile('\${esc(m.f2_name).replace(/'/g, "\\\\'")}')">\${esc((m.f2_display || m.f2_name || '?').slice(0, 24))}</text>\`;
      // Connector to next round
      if (r < rounds) {
        const nextStride = matchH * (2 ** r);
        const nextStartY = nextStride / 2 - matchH / 2 + margin;
        const nextI = Math.floor(i / 2);
        const nextY = nextStartY + nextI * nextStride + matchH / 2;
        const sx = x + matchW;
        const ex = x + colW;
        const mx = (sx + ex) / 2;
        svg += \`<polyline points="\${sx},\${y + matchH/2} \${mx},\${y + matchH/2} \${mx},\${nextY} \${ex},\${nextY}" stroke="#30363d" stroke-width="1.5" fill="none"/>\`;
      }
    }
  }
  // Champion box at the end
  if (rounds > 0) {
    const finalMatch = (byRound[rounds] || [])[0];
    if (finalMatch && finalMatch.victor_id) {
      const x = rounds * colW + margin;
      const y = totalH / 2 - matchH / 2;
      svg += \`<rect x="\${x}" y="\${y}" width="\${matchW}" height="\${matchH}" fill="#1f2933" stroke="#f0ae3c" stroke-width="2" rx="4"/>\`;
      svg += \`<text x="\${x + matchW/2}" y="\${y - 8}" fill="#f0ae3c" font-size="12" text-anchor="middle">CHAMPION</text>\`;
      svg += \`<text x="\${x + matchW/2}" y="\${y + matchH/2 + 6}" font-size="16" fill="#f0ae3c" font-weight="700" text-anchor="middle">\${esc(finalMatch.v_display || finalMatch.v_name || '')}</text>\`;
    }
  }
  svg += '</svg>';
  return svg;
}

function renderRoundRobinFs(t) {
  // Collect distinct fighter ids in match order
  const fighterMap = new Map();
  for (const m of t.matches) {
    if (!fighterMap.has(m.fighter_one_id)) fighterMap.set(m.fighter_one_id, m.f1_display || m.f1_name);
    if (!fighterMap.has(m.fighter_two_id)) fighterMap.set(m.fighter_two_id, m.f2_display || m.f2_name);
  }
  const ids = [...fighterMap.keys()];
  const wins = new Map(), played = new Map();
  for (const m of t.matches) {
    if (m.victor_id != null) {
      played.set(m.fighter_one_id, (played.get(m.fighter_one_id) || 0) + 1);
      played.set(m.fighter_two_id, (played.get(m.fighter_two_id) || 0) + 1);
      wins.set(m.victor_id, (wins.get(m.victor_id) || 0) + 1);
    }
  }
  const sortedIds = [...ids].sort((a, b) => (wins.get(b) || 0) - (wins.get(a) || 0));
  // Standings table
  let html = '<div style="display:flex;gap:24px;flex-wrap:wrap"><div><h3 style="font-size:13px;color:#8b949e;margin:0 0 8px">Standings</h3><table style="font-size:13px"><thead><tr><th style="text-align:left;padding:4px 8px">#</th><th style="text-align:left;padding:4px 8px">Fighter</th><th style="padding:4px 8px">W</th><th style="padding:4px 8px">L</th></tr></thead><tbody>';
  sortedIds.forEach((id, i) => {
    const w = wins.get(id) || 0;
    const p = played.get(id) || 0;
    html += \`<tr style="cursor:pointer" onclick="closeFullscreen();openProfile('\${esc(t.matches.find(m => m.fighter_one_id===id)?.f1_name || t.matches.find(m => m.fighter_two_id===id)?.f2_name || '').replace(/'/g, "\\\\'")}')"><td style="padding:3px 8px;color:#8b949e">\${i + 1}</td><td style="padding:3px 8px">\${esc(fighterMap.get(id))}</td><td style="padding:3px 8px;text-align:center;color:#3fb950">\${w}</td><td style="padding:3px 8px;text-align:center;color:#f85149">\${p - w}</td></tr>\`;
  });
  html += '</tbody></table></div>';
  // Matchup matrix (W/L grid)
  const lookup = new Map();
  for (const m of t.matches) {
    if (m.victor_id != null) {
      lookup.set(m.fighter_one_id + '_' + m.fighter_two_id, m.victor_id === m.fighter_one_id ? 'W' : 'L');
      lookup.set(m.fighter_two_id + '_' + m.fighter_one_id, m.victor_id === m.fighter_two_id ? 'W' : 'L');
    }
  }
  html += '<div><h3 style="font-size:13px;color:#8b949e;margin:0 0 8px">Matchup Matrix</h3><table class="matchup-matrix"><thead><tr><th></th>';
  for (const id of sortedIds) html += \`<th title="\${esc(fighterMap.get(id))}">\${esc(fighterMap.get(id).slice(0,3))}</th>\`;
  html += '</tr></thead><tbody>';
  for (const rowId of sortedIds) {
    html += \`<tr><th class="row-hdr">\${esc(fighterMap.get(rowId))}</th>\`;
    for (const colId of sortedIds) {
      if (rowId === colId) { html += '<td class="cell-u">—</td>'; continue; }
      const r = lookup.get(rowId + '_' + colId);
      const cls = r === 'W' ? 'cell-w' : r === 'L' ? 'cell-l' : 'cell-u';
      html += \`<td class="\${cls}">\${r || '·'}</td>\`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div></div>';
  return html;
}

async function refresh() {
  try {
    const r = await fetch('/api/state'); const s = await r.json();
    document.getElementById('match-info').innerHTML = s.match
      ? \`<strong>\${link(s.match.f1, s.match.f1_fn)}</strong> vs <strong>\${link(s.match.f2, s.match.f2_fn)}</strong>  ·  \${esc(s.match.stage)}\${s.match.round ? '  ·  round ' + s.match.round : ''}\`
      : 'Idle';
    updateFighterCard('fc-1', s.match?.f1_fn);
    updateFighterCard('fc-2', s.match?.f2_fn);
    document.getElementById('tourney-info').textContent = s.tournament
      ? \`Tournament #\${s.tournament.id} · \${s.tournament.name || ''} · size \${s.tournament.size}\`
      : '';
    lastTournament = s.tournament || null;
    document.getElementById('bracket').innerHTML = s.tournament ? renderBracket(s.tournament) : '<span style="color:#6e7681">(no active tournament)</span>';
    const lb = s.leaderboard.map(f =>
      \`<tr class="clickable" onclick="openProfile('\${esc(f.file_name).replace(/'/g,'\\\\\\'')}')"><td>\${esc(f.display_name || f.file_name)}<div class="author">\${esc(f.author || '')}</div></td><td>\${f.matches_won}</td><td>\${f.matches_lost}</td><td>\${f.matches_drawn}</td><td>\${f.win_rate}%</td></tr>\`
    ).join('');
    document.querySelector('#leaderboard tbody').innerHTML = lb;
    const h = s.history.map(m => {
      const f1 = link(m.f1, m.f1_fn);
      const f2 = link(m.f2, m.f2_fn);
      const vict = m.victor ? link(m.victor, m.victor_fn) : 'draw';
      return \`<tr><td>\${f1} vs \${f2}</td><td style="text-align:right">\${vict}</td></tr>\`;
    }).join('');
    document.querySelector('#history tbody').innerHTML = h;
  } catch (e) { console.error(e); }
}
function esc(s) { return String(s || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

// Fighter-card caching: don't re-fetch for the same fighter each poll.
const fcCache = new Map();
async function updateFighterCard(cardId, fileName) {
  const el = document.getElementById(cardId);
  if (!fileName) { el.classList.add('empty'); el.innerHTML = ''; return; }
  el.classList.remove('empty');
  let data = fcCache.get(fileName);
  if (!data) {
    try {
      const r = await fetch('/api/fighter/' + encodeURIComponent(fileName));
      if (!r.ok) return;
      data = await r.json();
      fcCache.set(fileName, data);
      // Evict cache after 5 min so stats refresh
      setTimeout(() => fcCache.delete(fileName), 5 * 60 * 1000);
    } catch { return; }
  }
  const recent = (data.recent || []).slice(0, 8).map(m => {
    const self = (data.display_name || data.file_name);
    const opp = (m.f1 === self || m.f1 === data.file_name) ? m.f2 : m.f1;
    let res, cls;
    if (!m.victor) { res = 'D'; cls = 'res-d'; }
    else if (m.victor_file === data.file_name || m.victor === self) { res = 'W'; cls = 'res-w'; }
    else { res = 'L'; cls = 'res-l'; }
    return \`<tr><td class="\${cls}">\${res}</td><td>\${esc(opp || '?')}</td></tr>\`;
  }).join('');
  el.innerHTML = \`
    <div class="fc-head">
      <img class="fc-portrait" src="/portrait/\${encodeURIComponent(data.file_name)}.png" onerror="this.style.visibility='hidden'">
      <div>
        <div class="fc-name" onclick="openProfile('\${esc(data.file_name).replace(/'/g, "\\\\'")}')">\${esc(data.display_name || data.file_name)}</div>
        <div class="fc-author">\${esc(data.author || '')}</div>
      </div>
    </div>
    <div class="fc-stats">
      <div class="fc-stat"><div class="v">\${data.matches_won}</div><div class="l">W</div></div>
      <div class="fc-stat"><div class="v">\${data.matches_lost}</div><div class="l">L</div></div>
      <div class="fc-stat"><div class="v">\${data.matches_drawn}</div><div class="l">D</div></div>
      <div class="fc-stat"><div class="v">\${data.win_rate}%</div><div class="l">Win</div></div>
    </div>
    \${recent ? \`<h3>Recent</h3><table>\${recent}</table>\` : ''}
  \`;
}
function link(label, fileName) {
  if (!fileName) return esc(label || '');
  return \`<span class="name-link" onclick="openProfile('\${esc(fileName).replace(/'/g,"\\\\'")}')">\${esc(label || fileName)}</span>\`;
}
function renderRoundRobinSidebar(t) {
  const fighterMap = new Map();
  for (const m of t.matches) {
    if (!fighterMap.has(m.fighter_one_id)) fighterMap.set(m.fighter_one_id, { name: m.f1_display || m.f1_name, fn: m.f1_name });
    if (!fighterMap.has(m.fighter_two_id)) fighterMap.set(m.fighter_two_id, { name: m.f2_display || m.f2_name, fn: m.f2_name });
  }
  const wins = new Map(), played = new Map();
  for (const m of t.matches) {
    if (m.victor_id != null) {
      played.set(m.fighter_one_id, (played.get(m.fighter_one_id) || 0) + 1);
      played.set(m.fighter_two_id, (played.get(m.fighter_two_id) || 0) + 1);
      wins.set(m.victor_id, (wins.get(m.victor_id) || 0) + 1);
    }
  }
  const sorted = [...fighterMap.entries()]
    .map(([id, f]) => ({ id, name: f.name, fn: f.fn, w: wins.get(id) || 0, p: played.get(id) || 0 }))
    .sort((a, b) => b.w - a.w || a.name.localeCompare(b.name));
  const completed = t.matches.filter((m) => m.victor_id).length;
  let out = '<div class="round-title">Standings · ' + completed + ' / ' + t.matches.length + '</div>';
  for (const f of sorted) {
    out += '<div class="match decided">' + link(f.name, f.fn) + ' <span class="vs">·</span> ' + f.w + 'W ' + (f.p - f.w) + 'L</div>';
  }
  const pending = t.matches.find((m) => !m.victor_id);
  if (pending) {
    out += '<div class="round-title" style="margin-top:10px">Up next</div>';
    out += '<div class="match">' + link(pending.f1_display || pending.f1_name, pending.f1_name) + ' <span class="vs">vs</span> ' + link(pending.f2_display || pending.f2_name, pending.f2_name) + '</div>';
  }
  return out;
}

function renderBracket(t) {
  if (t.format === 'roundrobin') return renderRoundRobinSidebar(t);
  const byRound = {};
  for (const m of t.matches) (byRound[m.round] ||= []).push(m);
  const rounds = Math.log2(t.size);
  const names = { 2: 'Final', 4: 'Semis', 8: 'Quarters' };
  let out = '';
  // Latest round first (so the current action is at the top, no scrolling to see it)
  for (let r = rounds; r >= 1; r--) {
    const label = names[t.size / (2 ** (r - 1))] || 'Round of ' + (t.size / (2 ** (r - 1)));
    const ms = byRound[r] || [];
    if (!ms.length) continue;
    out += '<div class="round"><div class="round-title">' + label + '</div>';
    for (const m of ms) {
      const f1Label = m.f1_display || m.f1_name || '?';
      const f2Label = m.f2_display || m.f2_name || '?';
      const vFn = m.v_name;
      const f1Html = m.f1_name ? link(f1Label, m.f1_name) : esc(f1Label);
      const f2Html = m.f2_name ? link(f2Label, m.f2_name) : esc(f2Label);
      if (vFn) {
        const vClass1 = vFn === m.f1_name ? 'winner' : '';
        const vClass2 = vFn === m.f2_name ? 'winner' : '';
        out += \`<div class="match decided"><span class="\${vClass1}">\${f1Html}</span> <span class="vs">vs</span> <span class="\${vClass2}">\${f2Html}</span></div>\`;
      } else {
        out += \`<div class="match">\${f1Html} <span class="vs">vs</span> \${f2Html}</div>\`;
      }
    }
    out += '</div>';
  }
  return out;
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

// New / Live page — tier-tabbed view of the current league.
const HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>MugenBattle Live</title>
<style>${COMMON_CSS}
  .tier-tabs { display: flex; gap: 8px; margin-bottom: 14px; }
  .tier-tabs .tab { padding: 8px 18px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; color: #8b949e; cursor: pointer; font-size: 13px; font-weight: 600; }
  .tier-tabs .tab:hover { color: #c9d1d9; }
  .tier-tabs .tab.active { background: #1d2a3a; color: #58a6ff; border-color: #58a6ff; }
  .tier-tabs .tab.tier-1.active { background: #3d2d0f; color: #f0ae3c; border-color: #f0ae3c; }
  .match-row { display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 14px; align-items: stretch; margin-bottom: 14px; }
  @media (max-width: 1100px) { .match-row { grid-template-columns: 1fr; } }
  .side-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
  .side-card .team-name { font-size: 15px; font-weight: 600; color: #c9d1d9; }
  .side-card .team-user { color: #8b949e; font-size: 12px; margin-top: -4px; }
  .side-card .portrait { width: 120px; height: 120px; align-self: center; background: #0d1117; border: 1px solid #21262d; border-radius: 8px; image-rendering: pixelated; object-fit: contain; }
  .side-card .fighter-name { font-size: 14px; font-weight: 600; color: #c9d1d9; text-align: center; }
  .side-card .fighter-master { font-size: 11px; color: #8b949e; text-align: center; font-style: italic; }
  .side-card .fighter-author { font-size: 10px; color: #6e7681; text-align: center; margin-top: -4px; }
  .side-card .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; font-size: 11px; }
  .side-card .stat { background: #0d1117; padding: 6px 2px; border-radius: 4px; text-align: center; }
  .side-card .stat .v { font-size: 15px; font-weight: 600; color: #c9d1d9; display: block; font-variant-numeric: tabular-nums; }
  .side-card .stat .l { color: #8b949e; font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; }
  .side-card .empty { color: #6e7681; text-align: center; margin-top: 30px; font-size: 13px; }
  .stream-col { display: flex; flex-direction: column; gap: 10px; }
  .stream-col .stream { background: #000; border-radius: 10px; overflow: hidden; aspect-ratio: 4 / 3; border: 1px solid #30363d; }
  .stream-col .stream img { width: 100%; height: 100%; object-fit: contain; display: block; image-rendering: pixelated; }
  .stream-col .stream .placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: #6e7681; font-size: 13px; }
  .stream-col .score-strip { text-align: center; padding: 10px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; }
  .stream-col .score-strip .score { font-size: 26px; font-weight: 600; color: #f0ae3c; font-variant-numeric: tabular-nums; }
  .stream-col .score-strip .live-pill { font-size: 16px; color: #f85149; letter-spacing: 1px; cursor: help; animation: live-pulse 1.6s ease-in-out infinite; }
  @keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .stream-col .score-strip .meta { color: #8b949e; font-size: 11px; margin-top: 4px; }
  /* Head-to-head panel under the stream — prior fixtures between the two
     teams currently in the ring. Read like "W · our P4 Hero · 2-1 · their Ryu". */
  .stream-col .h2h:empty { display: none; }
  .stream-col .h2h { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 1100px) { .stream-col .h2h { grid-template-columns: 1fr; } }
  .stream-col .h2h .h2h-block { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 10px 12px; }
  .stream-col .h2h .h2h-head { color: #8b949e; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 6px; }
  .stream-col .h2h .h2h-empty { color: #6e7681; font-size: 12px; }
  .stream-col .h2h .h2h-row { display: grid; grid-template-columns: 22px 1fr 60px 1fr 60px; gap: 8px; align-items: center; padding: 4px 2px; border-bottom: 1px solid #21262d; font-size: 12px; }
  .stream-col .h2h .h2h-row:last-child { border-bottom: 0; }
  .stream-col .h2h .h2h-res { font-weight: 600; text-align: center; font-size: 11px; }
  .stream-col .h2h .h2h-row.w .h2h-res { color: #3fb950; }
  .stream-col .h2h .h2h-row.l .h2h-res { color: #f85149; }
  .stream-col .h2h .h2h-row.d .h2h-res { color: #8b949e; }
  .stream-col .h2h .h2h-fighter { color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stream-col .h2h .h2h-them { color: #8b949e; text-align: right; }
  .stream-col .h2h .h2h-score { text-align: center; font-variant-numeric: tabular-nums; color: #c9d1d9; }
  .stream-col .h2h .h2h-loc { color: #6e7681; font-size: 10px; text-align: right; }
  .side-card .team-pos { color: #58a6ff; font-size: 11px; font-variant-numeric: tabular-nums; margin-top: -2px; }
  .sidebar-3 { display: grid; grid-template-columns: 1.2fr 1fr 1.2fr; gap: 14px; }
  @media (max-width: 1100px) { .sidebar-3 { grid-template-columns: 1fr; } }
  .sidebar-3 .panel { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 12px; }
  .sidebar-3 .panel h2 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #8b949e; }
  .sidebar-3 table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
  .sidebar-3 td, .sidebar-3 th { padding: 4px 6px; border-bottom: 1px solid #21262d; text-align: left; }
  .sidebar-3 th { color: #8b949e; font-weight: normal; font-size: 10px; text-transform: uppercase; }
  .sidebar-3 .pos { color: #6e7681; width: 24px; }
  .sidebar-3 .pos.p1 { color: #f0ae3c; font-weight: 600; }
  .sidebar-3 tr.mine td { background: #1d2a3e; }
  .sidebar-3 .w { color: #3fb950; font-weight: 600; }
  .sidebar-3 .l { color: #f85149; }
  .sidebar-3 .d { color: #8b949e; }
  .sidebar-3 .fighter-cell { color: #8b949e; font-size: 10px; font-style: italic; }
  /* Follow / star button + followed-team highlight. The highlight is a subtle
     yellow tint with a leading ★ glyph — visible without dominating the row,
     and consistent across every team-name surface (cards, sidebar, schedule). */
  .star { background: transparent; border: 0; color: #6e7681; cursor: pointer; font-size: 14px; padding: 0 4px; line-height: 1; transition: color 0.1s, transform 0.1s; }
  .star:hover { color: #f0ae3c; transform: scale(1.15); }
  .star.on { color: #f0ae3c; }
  /* Team star sits inline with the team name; fighter star is inline with the
     fighter name. Both are slightly smaller than the line-height so the row
     stays balanced. */
  .side-card .team-name .star { font-size: 14px; vertical-align: middle; }
  .side-card .fighter-row { display: flex; align-items: center; justify-content: center; gap: 4px; }
  .side-card .fighter-row .star { font-size: 13px; }
  .team-link { color: inherit; text-decoration: none; }
  .team-link:hover { text-decoration: underline; }
  .team-link.followed { color: #f0ae3c; font-weight: 600; }
  .team-link.followed::before { content: '★ '; font-size: 0.9em; }
</style></head>
<body style="position:relative">
${AUTH_BAR_HTML}
<h1>🥊 MugenBattle Live</h1>
<nav>
  <a href="/" class="active">Live</a>
  <a href="/leagues">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market">Market</a>
  <a href="/exhibition">Exhibition</a>
  <a href="/trades">Trades</a>
  <a href="/tournaments">Tournaments</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>

<div class="tier-tabs" id="tier-tabs"></div>

<div class="match-row">
  <div class="side-card" id="home-card"><div class="empty">Loading…</div></div>
  <div class="stream-col">
    <div class="stream" id="stream-wrap"><div class="placeholder">Loading stream…</div></div>
    <div class="score-strip">
      <div class="score" id="score">— –  —</div>
      <div class="meta" id="score-meta">&nbsp;</div>
    </div>
    <div class="h2h" id="h2h"></div>
  </div>
  <div class="side-card" id="away-card"><div class="empty">Loading…</div></div>
</div>

<div class="sidebar-3">
  <div class="panel"><h2>Table — League <span id="sb-tier">—</span></h2><div id="standings"></div></div>
  <div class="panel"><h2>Upcoming</h2><div id="upcoming"></div></div>
  <div class="panel"><h2>Recent</h2><div id="recent"></div></div>
</div>

${MODAL_HTML}
${AUTH_MODAL_HTML}
${AUTH_JS}
<script>
function esc(s){return String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
// Restore the last league the user was watching so the Live page lands on
// the same tab next time. Clamped to [1,3] so a stale value (or a future
// schema change) can't leave the tab in an invalid state.
const LIVE_LAST_TIER_KEY = 'mb.live.activeTier';
let activeTier = (() => {
  try {
    const v = parseInt(localStorage.getItem(LIVE_LAST_TIER_KEY) || '1', 10);
    return Number.isInteger(v) && v >= 1 && v <= 3 ? v : 1;
  } catch { return 1; }
})();
let currentWorkerId = null;
// Followed targets — kept as Sets so every team-name render can do an O(1)
// membership check. Reloaded from the server only on auth changes; toggle
// updates the local sets optimistically so the UI reacts immediately.
const followed = { masters: new Set(), teams: new Set() };

async function loadFollows() {
  followed.masters.clear();
  followed.teams.clear();
  if (!window.__authState || !window.__authState.authenticated) return;
  try {
    const r = await fetch('/api/follow');
    if (!r.ok) return;
    const j = await r.json();
    (j.masters || []).forEach(id => followed.masters.add(id));
    (j.teams || []).forEach(id => followed.teams.add(id));
  } catch {}
}

async function toggleFollow(kind, id, evt) {
  if (evt) { evt.stopPropagation(); evt.preventDefault(); }
  if (!window.__authState || !window.__authState.authenticated) {
    alert('Sign in to follow.');
    return;
  }
  const set = kind === 'master' ? followed.masters : followed.teams;
  const wasFollowing = set.has(id);
  if (wasFollowing) {
    set.delete(id);
    fetch('/api/follow/' + kind + '/' + id, { method: 'DELETE' });
  } else {
    set.add(id);
    fetch('/api/follow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id }),
    });
  }
  refresh();
}

function teamLabel(id, name) {
  const cls = followed.teams.has(id) ? ' followed' : '';
  return '<a class="team-link' + cls + '" href="/team/' + id + '">' + esc(name) + '</a>';
}

// Star button. Tooltip is purpose-specific because team-follow and master-
// follow do different things — team-follow is cosmetic (highlight the name
// wherever it appears); master-follow is utility (surface to the top of the
// market when the fighter is listed). Hollow ☆ vs filled ★ shows state at
// a glance even without hover.
function starBtn(kind, id, label) {
  const on = (kind === 'master' ? followed.masters : followed.teams).has(id);
  const glyph = on ? '★' : '☆';
  let tip;
  if (kind === 'team') {
    tip = on
      ? 'Unfollow ' + label + ' (currently highlighted everywhere)'
      : 'Follow ' + label + ' — highlights the team name everywhere it appears';
  } else {
    tip = on
      ? 'Unfollow ' + label + ' — won\\'t auto-surface to the market top anymore'
      : 'Follow ' + label + ' — pins them to the top of the market if listed';
  }
  return '<button class="star' + (on ? ' on' : '') + '" data-kind="' + kind +
    '" title="' + tip + '" aria-label="' + tip +
    '" onclick="toggleFollow(\\'' + kind + '\\',' + id + ',event)">' + glyph + '</button>';
}

function renderTabs(league) {
  const tabs = document.getElementById('tier-tabs');
  tabs.innerHTML = '';
  // Render one tab per tier the league actually has. Falls back to 3 if
  // the API didn't surface a division_count (older view payloads).
  const divCount = (league && league.division_count) || 3;
  for (let t = 1; t <= divCount; t++) {
    const el = document.createElement('div');
    el.className = 'tab tier-' + t + (t === activeTier ? ' active' : '');
    el.textContent = 'League ' + t;
    el.onclick = () => {
      activeTier = t;
      try { localStorage.setItem(LIVE_LAST_TIER_KEY, String(t)); } catch {}
      refresh(true);
    };
    tabs.appendChild(el);
  }
}

function renderSideCard(hostId, side) {
  const host = document.getElementById(hostId);
  if (!side) { host.innerHTML = '<div class="empty">No team yet</div>'; return; }
  const f = side.fighter;
  const posLine = side.position
    ? '<div class="team-pos" title="Current league position">#' + side.position +
      ' · ' + side.points + ' pts · ' + side.fixtures_played + ' played</div>'
    : '';
  const teamHdr =
    '<div class="team-name">' +
      teamLabel(side.team_id, side.team_name) +
      ' ' + starBtn('team', side.team_id, side.team_name) +
    '</div>' +
    '<div class="team-user">@' + esc(side.username) + '</div>' +
    posLine;
  if (!f) {
    host.innerHTML = teamHdr + '<div class="empty">Picking fighter…</div>';
    return;
  }
  const masterName = f.master_display_name || f.master_file_name;
  const masterId = f.master_fighter_id;
  const authorLine = f.master_author ? '<div class="fighter-author">by ' + esc(f.master_author) + '</div>' : '';
  const stam = Number(f.stamina || 0).toFixed(2);
  host.innerHTML = teamHdr +
    '<img class="portrait" src="/portrait/' + encodeURIComponent(f.master_file_name) + '.png" onerror="this.style.visibility=\\'hidden\\'">' +
    '<div class="fighter-row">' +
      '<div class="fighter-name" title="' + esc(f.display_name) + ' — this team\\'s nickname for the fighter">' + esc(f.display_name) + '</div>' +
      starBtn('master', masterId, masterName) +
    '</div>' +
    '<div class="fighter-master" title="Underlying character. Click the star to follow.">' + esc(masterName) + '</div>' +
    authorLine +
    '<div class="stat-grid">' +
      '<div class="stat" title="Career matches won by this fighter"><span class="v">' + f.matches_won + '</span><span class="l">W</span></div>' +
      '<div class="stat" title="Career matches lost"><span class="v">' + f.matches_lost + '</span><span class="l">L</span></div>' +
      '<div class="stat" title="Career draws"><span class="v">' + f.matches_drawn + '</span><span class="l">D</span></div>' +
      '<div class="stat" title="Stamina (1.0 = full HP for the next match, drops 0.20 per fight, recovers 0.25 while resting)"><span class="v">' + stam + '</span><span class="l">Stam</span></div>' +
    '</div>';
}

// Head-to-head panel under the stream — two blocks side by side:
//   1. Team H2H: fixtures between the two TEAMS regardless of who they fielded
//   2. Fighter H2H: prior matches between the two MASTER FIGHTERS in the ring,
//      across all leagues and owners
function renderHeadToHead(teamRows, fighterRows, home, away) {
  const host = document.getElementById('h2h');
  if (!host) return;
  if (!home || !away) { host.innerHTML = ''; return; }
  // Drop fixtures that never had real fighter info on slot 1.
  const teamPlayed = (teamRows || []).filter((r) => r.home_fighter && r.away_fighter);
  const fighterPlayed = (fighterRows || []);

  const teamItems = teamPlayed.map((r) => {
    const homeWasHome = r.home_team_id === home.team_id;
    const ourScore = homeWasHome ? r.home_rounds : r.away_rounds;
    const theirScore = homeWasHome ? r.away_rounds : r.home_rounds;
    const ourFighter = homeWasHome ? r.home_fighter : r.away_fighter;
    const theirFighter = homeWasHome ? r.away_fighter : r.home_fighter;
    let cls;
    if (r.winner_team_id == null) cls = 'd';
    else if (r.winner_team_id === home.team_id) cls = 'w';
    else cls = 'l';
    const label = cls === 'w' ? 'W' : cls === 'l' ? 'L' : 'D';
    return '<div class="h2h-row ' + cls + '">' +
      '<span class="h2h-res">' + label + '</span>' +
      '<span class="h2h-fighter">' + esc(ourFighter || '—') + '</span>' +
      '<span class="h2h-score">' + ourScore + '–' + theirScore + '</span>' +
      '<span class="h2h-fighter h2h-them">' + esc(theirFighter || '—') + '</span>' +
      '<span class="h2h-loc">L' + r.tier + ' R' + r.round_num + '</span>' +
    '</div>';
  }).join('');

  const homeMasterId = home.fighter && home.fighter.master_fighter_id;
  const fighterItems = fighterPlayed.map((r) => {
    const ourMasterIsHome = r.home_master_id === homeMasterId;
    const ourScore = ourMasterIsHome ? r.home_rounds : r.away_rounds;
    const theirScore = ourMasterIsHome ? r.away_rounds : r.home_rounds;
    const ourFighter = ourMasterIsHome ? r.home_fighter : r.away_fighter;
    const theirFighter = ourMasterIsHome ? r.away_fighter : r.home_fighter;
    const ourTeamName = ourMasterIsHome ? r.home_team_name : r.away_team_name;
    const theirTeamName = ourMasterIsHome ? r.away_team_name : r.home_team_name;
    let cls;
    if (ourScore > theirScore) cls = 'w';
    else if (ourScore < theirScore) cls = 'l';
    else cls = 'd';
    const label = cls === 'w' ? 'W' : cls === 'l' ? 'L' : 'D';
    return '<div class="h2h-row ' + cls + '">' +
      '<span class="h2h-res">' + label + '</span>' +
      '<span class="h2h-fighter" title="' + esc(ourFighter || '') + ' (' + esc(ourTeamName || '') + ')">' + esc(ourFighter || '—') + '</span>' +
      '<span class="h2h-score">' + ourScore + '–' + theirScore + '</span>' +
      '<span class="h2h-fighter h2h-them" title="' + esc(theirFighter || '') + ' (' + esc(theirTeamName || '') + ')">' + esc(theirFighter || '—') + '</span>' +
      '<span class="h2h-loc">L' + r.tier + ' R' + r.round_num + '</span>' +
    '</div>';
  }).join('');

  const teamBlock = '<div class="h2h-block">' +
    '<div class="h2h-head">Team head-to-head' + (teamPlayed.length ? ' · ' + teamPlayed.length + ' prior' : '') + '</div>' +
    (teamItems || '<div class="h2h-empty">These teams have never met.</div>') +
    '</div>';

  const fighterMasterHome = home.fighter && home.fighter.master_display_name;
  const fighterMasterAway = away.fighter && away.fighter.master_display_name;
  const fighterHeadLabel = (fighterMasterHome && fighterMasterAway)
    ? esc(fighterMasterHome) + ' vs ' + esc(fighterMasterAway)
    : 'Fighter head-to-head';
  const fighterBlock = '<div class="h2h-block">' +
    '<div class="h2h-head">' + fighterHeadLabel + (fighterPlayed.length ? ' · ' + fighterPlayed.length + ' prior' : '') + '</div>' +
    (fighterItems || '<div class="h2h-empty">These fighters have never met.</div>') +
    '</div>';

  host.innerHTML = teamBlock + fighterBlock;
}

function renderStream(workerId) {
  const host = document.getElementById('stream-wrap');
  if (!workerId) { host.innerHTML = '<div class="placeholder">Waiting for this league\\'s stream to start…</div>'; currentWorkerId = null; return; }
  if (workerId !== currentWorkerId) {
    host.innerHTML = '<img src="/stream/' + workerId + '" alt="">';
    currentWorkerId = workerId;
  }
}

function renderStandings(rows, viewerTeamId) {
  const host = document.getElementById('standings');
  if (!rows.length) { host.innerHTML = '<div style="color:#6e7681">No standings yet.</div>'; return; }
  const body = rows.map((s, i) => {
    const mine = s.team_id === viewerTeamId ? ' class="mine"' : '';
    return '<tr' + mine + '><td class="pos' + (i === 0 ? ' p1' : '') + '">' + (i + 1) + '</td>' +
      '<td>' + teamLabel(s.team_id, s.team_name) + '</td>' +
      '<td>' + s.fixtures_played + '</td>' +
      '<td>' + s.fixtures_won + '</td>' +
      '<td>' + s.fixtures_drawn + '</td>' +
      '<td>' + s.fixtures_lost + '</td>' +
      '<td>' + s.points + '</td></tr>';
  }).join('');
  host.innerHTML = '<table><thead><tr>' +
    '<th>#</th><th>Team</th><th title="Played">P</th>' +
    '<th title="Won">W</th><th title="Drawn">D</th><th title="Lost">L</th>' +
    '<th title="Points">Pts</th>' +
    '</tr></thead><tbody>' + body + '</tbody></table>';
}

function renderUpcoming(rows) {
  const host = document.getElementById('upcoming');
  if (!rows.length) { host.innerHTML = '<div style="color:#6e7681">None.</div>'; return; }
  host.innerHTML = '<table><tbody>' + rows.map(r =>
    '<tr><td>R' + r.round_num + '</td>' +
      '<td>' + teamLabel(r.home_team_id, r.home_team_name) + '</td>' +
      '<td style="color:#6e7681">vs</td>' +
      '<td>' + teamLabel(r.away_team_id, r.away_team_name) + '</td></tr>'
  ).join('') + '</tbody></table>';
}

function renderRecent(rows) {
  const host = document.getElementById('recent');
  if (!rows.length) { host.innerHTML = '<div style="color:#6e7681">No results yet.</div>'; return; }
  host.innerHTML = '<table><tbody>' + rows.map(r => {
    const hCls = r.winner_team_id && r.winner_team_id === r.home_team_id ? 'w' : (r.winner_team_id ? 'l' : 'd');
    const aCls = r.winner_team_id && r.winner_team_id === r.away_team_id ? 'w' : (r.winner_team_id ? 'l' : 'd');
    const hFighter = r.home_fighter ? '<div class="fighter-cell">' + esc(r.home_fighter) + '</div>' : '';
    const aFighter = r.away_fighter ? '<div class="fighter-cell">' + esc(r.away_fighter) + '</div>' : '';
    return '<tr>' +
      '<td class="' + hCls + '">' + teamLabel(r.home_team_id, r.home_team_name) + hFighter + '</td>' +
      '<td style="text-align:center;font-variant-numeric:tabular-nums">' + r.home_rounds + '-' + r.away_rounds + '</td>' +
      '<td class="' + aCls + '">' + teamLabel(r.away_team_id, r.away_team_name) + aFighter + '</td>' +
    '</tr>';
  }).join('') + '</tbody></table>';
}

async function viewerTeamId() {
  if (!window.__authState || !window.__authState.authenticated) return null;
  try {
    const r = await fetch('/api/me/team');
    if (!r.ok) return null;
    const t = await r.json();
    return t.id || null;
  } catch { return null; }
}

async function refresh(fromTab = false) {
  renderTabs();
  const r = await fetch('/api/live/' + activeTier);
  const view = await r.json();
  document.getElementById('sb-tier').textContent = activeTier;
  if (!view || !view.league) {
    renderSideCard('home-card', null);
    renderSideCard('away-card', null);
    renderStream(null);
    renderStandings([]); renderUpcoming([]); renderRecent([]);
    document.getElementById('score').textContent = '—';
    document.getElementById('score-meta').textContent = 'No active season';
    return;
  }
  const cur = view.current;
  if (cur) {
    // Annotate each side with its current standings position so the side
    // card can render "#3 · 12 pts" under the @username.
    const standings = view.standings || [];
    const augment = (side) => {
      if (!side) return side;
      const idx = standings.findIndex((s) => s.team_id === side.team_id);
      if (idx < 0) return side;
      const s = standings[idx];
      return { ...side, position: idx + 1, points: s.points, fixtures_played: s.fixtures_played };
    };
    renderSideCard('home-card', augment(cur.home));
    renderSideCard('away-card', augment(cur.away));
    renderHeadToHead(view.team_h2h || [], view.fighter_h2h || [], cur.home, cur.away);
    // Ikemen doesn't write round-by-round results to the match log — the
    // p1wins/p2wins values only land at the very end of the match. So we
    // genuinely don't know the live score during play. Show a "live" pill
    // instead of a misleading 0–0; the final score appears in the Recent
    // panel the moment the match wraps.
    const scoreEl = document.getElementById('score');
    scoreEl.innerHTML = '<span class="live-pill" title="Round score isn\\'t available live — the final score appears under Recent the moment the match ends.">● LIVE</span>';
    const stageBit = cur.stage
      ? 'Stage: ' + esc(cur.stage) + (cur.stage_author ? ' <span style="color:#6e7681">by ' + esc(cur.stage_author) + '</span>' : '') + ' · '
      : '';
    document.getElementById('score-meta').innerHTML =
      stageBit +
      'Round ' + cur.round + ' · ' + esc(view.league.name);
  } else {
    renderSideCard('home-card', null);
    renderSideCard('away-card', null);
    document.getElementById('score').textContent = '—';
    document.getElementById('score-meta').textContent = 'Between fixtures — ' + esc(view.league.name);
    document.getElementById('h2h').innerHTML = '';
  }
  renderStream(view.stream_worker_id);
  const viewer = await viewerTeamId();
  renderStandings(view.standings || [], viewer);
  renderUpcoming(view.upcoming || []);
  renderRecent(view.recent || []);
}

loadFollows().then(() => refresh());
setInterval(refresh, 2000);
</script>
</body></html>`;

function readJsonBody(req, maxBytes = 1_048_576 /* 1 MiB */) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readBinaryBody(req, maxBytes = 100 * 1024 * 1024 /* 100 MiB */) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- HTTP server ----------

const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.url === '/tournament' || req.url === '/tournament/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TOURNAMENT_HTML);
    return;
  }
  // MJPEG streams. /stream aliases worker 1 for backwards compat.
  const streamMatch = req.url && req.url.match(/^\/stream(?:\/(\d+))?$/);
  if (streamMatch) {
    const id = streamMatch[1] ? Number(streamMatch[1]) : 1;
    const w = workers.get(id);
    if (!w) { res.writeHead(404); res.end('no such worker'); return; }
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
      'Connection': 'close',
    });
    const detach = w.attachClient(res);
    req.on('close', detach);
    return;
  }
  const liveTierMatch = req.url && req.url.match(/^\/api\/live\/(\d+)$/);
  if (liveTierMatch) {
    const tier = Number(liveTierMatch[1]);
    const db = getDb();
    const view = getLiveTierView(db, tier);
    if (!view) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ league: null })); return;
    }
    // Find the stream worker currently running this tier's division.
    const w = Array.from(workers.values()).find((ww) => ww.divisionId === view.division.id);
    view.stream_worker_id = w ? w.workerId : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(view));
    return;
  }
  if (req.url === '/api/pyramid') {
    const db = getDb();
    const leagueId = latestInterestingLeagueId(db);
    if (!leagueId) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ league: null, divisions: [], viewer_team_id: null }));
      return;
    }
    const data = getStandings(db, leagueId);
    const me = currentUser(db, req);
    let viewerTeamId = null;
    if (me) {
      const row = db.prepare('SELECT id FROM team WHERE user_id = ?').get(me.id);
      viewerTeamId = row?.id ?? null;
    }
    // Queue to get in: orphan teams ordered the same way autoCreateSeason
    // picks them (never-played first, newest user_id first within each
    // group). Real-user signups always go ahead of bots — they get D3 slots
    // before bots fill the rest. Limited to the next 25 because the rest
    // probably won't surface for several seasons.
    const queueRows = db.prepare(`
      SELECT t.id AS team_id, t.name AS team_name,
        u.id AS user_id, u.username, u.is_bot
      FROM team t
      JOIN user_account u ON u.id = t.user_id
      WHERE t.current_league_id IS NULL
        AND (SELECT COUNT(*) FROM owned_fighter o
             WHERE o.team_id = t.id AND o.is_retired = 0 AND o.slot = 'active') >= 5
      ORDER BY
        u.is_bot ASC,
        CASE WHEN EXISTS (
          SELECT 1 FROM fixture f WHERE f.home_team_id = t.id OR f.away_team_id = t.id
        ) THEN 1 ELSE 0 END,
        u.id DESC
      LIMIT 25
    `).all();
    // How many slots open up at the bottom of the bracket per season →
    // 1 promotion per relegating tier, so D3 frees `promotePerTier` spots.
    const slotsOpening = parseInt(process.env.STREAM_AUTO_PROMOTE_PER_TIER || '3', 10);
    const queue = queueRows.map((q, i) => ({ ...q, will_seat_next_season: i < slotsOpening }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...data, viewer_team_id: viewerTeamId, queue, slots_opening: slotsOpening }));
    return;
  }
  if (req.url === '/api/workers') {
    const db = getDb();
    const data = Array.from(workers.values())
      .filter((w) => w.kind === 'league')
      .map((w) => {
        const base = w.describe();
        const ctx = w.leagueId ? getLiveLeagueContext(db, w.leagueId, w.divisionId) : null;
        return { ...base, context: ctx };
      });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }
  if (req.url === '/audiostream') {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'Connection': 'close',
      'Transfer-Encoding': 'chunked',
    });
    audioClients.add(res);
    req.on('close', () => audioClients.delete(res));
    return;
  }
  if (req.url === '/api/state') {
    const match = readMatchState();
    const leaderboard = getLeaderboard(15);
    const tournament = getActiveTournament();
    const history = getRecentHistory(8);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ match, leaderboard, tournament, history }));
    return;
  }
  if (req.url === '/leagues' || req.url === '/leagues/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LEAGUES_HTML);
    return;
  }
  if (req.url === '/pyramid' || req.url === '/pyramid/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PYRAMID_HTML);
    return;
  }
  const scoutMatch = req.url && req.url.match(/^\/team\/(\d+)$/);
  if (scoutMatch && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SCOUT_HTML);
    return;
  }
  if (req.url === '/team' || req.url === '/team/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEAM_HTML);
    return;
  }
  if (req.url === '/market' || req.url === '/market/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(MARKET_HTML);
    return;
  }
  if (req.url === '/leaderboard' || req.url === '/leaderboard/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LEADERBOARD_HTML);
    return;
  }
  if (req.url === '/exhibition' || req.url === '/exhibition/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(EXHIBITION_HTML);
    return;
  }
  if (req.url === '/tournaments' || req.url === '/tournaments/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TOURNAMENTS_HTML);
    return;
  }
  if (req.url === '/trades' || req.url === '/trades/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TRADES_HTML);
    return;
  }
  if (req.url && req.url.startsWith('/api/trades')) {
    const db = getDb();
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
    // Pull recent buys from wallet_ledger (the canonical record of money
    // movement). Each buy_master entry produces one row; each listing-buy
    // produces TWO ledger entries (debit on buyer, credit on seller) — we
    // dedupe to one trade event per ref_id by collapsing on (kind, ref_id).
    // We also pull each actor's team_id so the UI can link @username → /team/<id>.
    const rows = db.prepare(`
      SELECT w.id, w.user_id, w.delta_cents, w.reason, w.ref_id, w.created_at,
        u.username AS actor_username, u.is_bot AS actor_is_bot,
        actor_team.id AS actor_team_id,
        of.id AS owned_id, of.team_id AS owned_team_id, of.display_name AS owned_display,
        f.id AS master_id, f.file_name AS master_file_name,
        f.display_name AS master_display, f.author AS master_author
      FROM wallet_ledger w
      JOIN user_account u ON u.id = w.user_id
      LEFT JOIN team actor_team ON actor_team.user_id = u.id
      LEFT JOIN owned_fighter of ON of.id = w.ref_id
      LEFT JOIN fighter f ON f.id = of.master_fighter_id
      WHERE w.reason LIKE 'buy_master%' OR w.reason = 'buy_listing'
         OR w.reason = 'sell_listing' OR w.reason = 'release' OR w.reason = 'list'
      ORDER BY w.id DESC
      LIMIT ?
    `).all(limit * 2);
    // Group by (reason category, ref_id, created_at-bucket) so the buyer+seller
    // halves of a listing-buy collapse into one trade event with both sides.
    const trades = [];
    const seen = new Set();
    for (const r of rows) {
      const cat = r.reason.startsWith('buy_master')
        ? 'buy_master'
        : (r.reason === 'buy_listing' || r.reason === 'sell_listing')
        ? 'listing_trade'
        : r.reason; // 'release' passes through
      const key = cat + '|' + (r.ref_id || 0) + '|' + r.created_at;
      if (seen.has(key)) continue;
      seen.add(key);
      let buyer = null, seller = null;
      if (cat === 'buy_master') {
        buyer = { user_id: r.user_id, username: r.actor_username, is_bot: r.actor_is_bot, team_id: r.actor_team_id };
      } else if (cat === 'release') {
        // Release: the actor used to own the fighter; surface them as 'seller'
        // so the UI can render "@user released X" similarly.
        seller = { user_id: r.user_id, username: r.actor_username, is_bot: r.actor_is_bot, team_id: r.actor_team_id };
      } else if (cat === 'list') {
        // List: the actor put a fighter up for sale. Surface them as 'seller'.
        seller = { user_id: r.user_id, username: r.actor_username, is_bot: r.actor_is_bot, team_id: r.actor_team_id };
      } else {
        // listing trade: find both halves in `rows`
        const halves = rows.filter((x) => x.ref_id === r.ref_id && x.created_at === r.created_at);
        const buyHalf = halves.find((h) => h.delta_cents < 0);
        const sellHalf = halves.find((h) => h.delta_cents > 0);
        buyer = buyHalf && { user_id: buyHalf.user_id, username: buyHalf.actor_username, is_bot: buyHalf.actor_is_bot, team_id: buyHalf.actor_team_id };
        seller = sellHalf && { user_id: sellHalf.user_id, username: sellHalf.actor_username, is_bot: sellHalf.actor_is_bot, team_id: sellHalf.actor_team_id };
      }
      const kind = cat === 'buy_master' ? 'buy_unclaimed'
                 : cat === 'release' ? 'release'
                 : cat === 'list' ? 'list'
                 : 'buy_listing';
      // For 'list' events the asking price isn't in delta_cents (which is 0
      // because no money moved). Look it up from owned_fighter via ref_id.
      let priceCents = Math.abs(r.delta_cents);
      if (cat === 'list' && r.ref_id) {
        const lp = db.prepare('SELECT listing_price_cents FROM owned_fighter WHERE id = ?').get(r.ref_id);
        priceCents = lp?.listing_price_cents ?? 0;
      }
      trades.push({
        id: r.id,
        kind,
        price_cents: priceCents,
        created_at: r.created_at,
        buyer,
        seller,
        master: r.master_id ? {
          id: r.master_id,
          file_name: r.master_file_name,
          display_name: r.master_display,
          author: r.master_author,
        } : null,
      });
      if (trades.length >= limit) break;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(trades));
    return;
  }
  if (req.url === '/api/leaderboard') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFullLeaderboard()));
    return;
  }
  const profileMatch = req.url && req.url.match(/^\/api\/fighter\/(.+)$/);
  if (profileMatch) {
    const name = decodeURIComponent(profileMatch[1]);
    const p = getFighterProfile(name);
    if (!p) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(p));
    return;
  }
  if (req.url === '/api/auth/me') {
    const db = getDb();
    const u = currentUser(db, req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(
      u
        ? {
            authenticated: true,
            username: u.username,
            needs_username: !u.username,
          }
        : { authenticated: false }
    ));
    return;
  }
  if (req.url === '/api/auth/set-username' && req.method === 'POST') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not signed in' }));
      return;
    }
    readJsonBody(req).then((data) => {
      const result = setUsername(db, u.id, data.username);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  if (req.url === '/api/auth/send-code' && req.method === 'POST') {
    readJsonBody(req).then(async (data) => {
      const result = await sendCode(getDb(), data.email);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  if (req.url === '/api/auth/verify-code' && req.method === 'POST') {
    readJsonBody(req).then((data) => {
      const result = verifyCode(getDb(), data.email, data.code);
      const headers = { 'Content-Type': 'application/json' };
      if (result.cookie) headers['Set-Cookie'] = sessionCookieHeader(result.cookie);
      res.writeHead(result.status, headers);
      res.end(JSON.stringify(result.body));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  if (req.url === '/api/auth/logout' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookieHeader('', { clear: true }),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/me/team') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const team = getTeamForUser(db, u.id);
    if (team) team.notices = listOpenNotices(db, team.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(team || { error: 'No team yet' }));
    return;
  }
  const dismissNoticeMatch = req.url && req.url.match(/^\/api\/me\/team\/notices\/(\d+)\/dismiss$/);
  if (dismissNoticeMatch && req.method === 'POST') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const team = db.prepare('SELECT id FROM team WHERE user_id = ?').get(u.id);
    if (!team) { res.writeHead(404); res.end('{"error":"No team"}'); return; }
    const r = dismissNotice(db, team.id, Number(dismissNoticeMatch[1]));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }

  // ---------- Exhibition matches ----------
  if (req.url === '/api/exhibition/fighters' && req.method === 'GET') {
    const db = getDb();
    const u = currentUser(db, req);
    const data = listExhibitionFighters(db, u?.id || null);
    const recent = u ? listExhibitionsForUser(db, u.id, 10) : [];
    const activeTournament = u ? getActiveTournamentForUser(db, u.id) : null;
    const stages = db.prepare(
      `SELECT id, display_name, file_name FROM stage WHERE active = 1 ORDER BY display_name`
    ).all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...data, recent, signed_in: !!u, active_tournament: activeTournament, stages }));
    return;
  }
  if (req.url === '/api/exhibition' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const db = getDb();
      const u = currentUser(db, req);
      if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
      const homeId = Number(body?.home_owned_fighter_id);
      const awayId = Number(body?.away_owned_fighter_id);
      const stageId = body?.stage_id != null ? Number(body.stage_id) : null;
      if (!homeId || !awayId) { res.writeHead(400); res.end('{"error":"home and away required"}'); return; }
      const r = enqueueExhibition(db, { requesterId: u.id, homeId, awayId, stageId });
      if (r.error) { res.writeHead(400); res.end(JSON.stringify(r)); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: r.id }));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  if (req.url === '/api/tournaments' && req.method === 'GET') {
    const db = getDb();
    const list = listLiveTournaments(db);
    // Annotate each running tournament with the worker currently streaming
    // its match (if any) so the public page can embed live MJPEGs.
    const annotated = list.map((t) => {
      let streamWorkerId = null;
      let runningMatchId = null;
      const runningMatch = t.matches.find((m) => m.status === 'running');
      if (runningMatch) {
        runningMatchId = runningMatch.id;
        const w = Array.from(workers.values()).find((ww) => ww.tournamentMatchId === runningMatch.id);
        streamWorkerId = w ? w.workerId : null;
      }
      return { ...t, stream_worker_id: streamWorkerId, running_match_id: runningMatchId };
    });
    const recent = listRecentTournaments(db, 5);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tournaments: annotated, recent, max_concurrent: MAX_CONCURRENT_TOURNAMENTS }));
    return;
  }
  if (req.url === '/api/exhibition/tournament' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const db = getDb();
      const u = currentUser(db, req);
      if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
      const size = Number(body?.size);
      const roundsPerFight = Number(body?.rounds_per_fight);
      const slotIds = Array.isArray(body?.slot_ids) ? body.slot_ids.map(Number) : null;
      const stageId = body?.stage_id != null && body.stage_id !== '' ? Number(body.stage_id) : null;
      if (!size || !roundsPerFight || !slotIds) { res.writeHead(400); res.end('{"error":"size, rounds_per_fight, slot_ids required"}'); return; }
      const r = createExhibitionTournament(db, { requesterId: u.id, size, roundsPerFight, slotIds, stageId });
      if (r.error) { res.writeHead(400); res.end(JSON.stringify(r)); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: r.id }));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  const exhibitionTournamentMatch = req.url && req.url.match(/^\/api\/exhibition\/tournament\/(\d+)$/);
  if (exhibitionTournamentMatch && req.method === 'GET') {
    const db = getDb();
    const t = getExhibitionTournament(db, Number(exhibitionTournamentMatch[1]));
    if (!t) { res.writeHead(404); res.end('{"error":"not_found"}'); return; }
    // Surface the worker that's currently running a match for this
    // tournament so the page can embed its MJPEG stream.
    let streamWorkerId = null;
    let runningMatchId = null;
    const runningMatch = t.matches.find((m) => m.status === 'running');
    if (runningMatch) {
      runningMatchId = runningMatch.id;
      const w = Array.from(workers.values()).find((ww) => ww.tournamentMatchId === runningMatch.id);
      streamWorkerId = w ? w.workerId : null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...t, stream_worker_id: streamWorkerId, running_match_id: runningMatchId }));
    return;
  }
  const exhibitionTournamentCancel = req.url && req.url.match(/^\/api\/exhibition\/tournament\/(\d+)\/cancel$/);
  if (exhibitionTournamentCancel && req.method === 'POST') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const r = cancelExhibitionTournament(db, { id: Number(exhibitionTournamentCancel[1]), userId: u.id });
    if (r.error) { res.writeHead(400); res.end(JSON.stringify(r)); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const exhibitionByIdMatch = req.url && req.url.match(/^\/api\/exhibition\/(\d+)$/);
  if (exhibitionByIdMatch && req.method === 'GET') {
    const db = getDb();
    const id = Number(exhibitionByIdMatch[1]);
    const ex = getExhibition(db, id);
    if (!ex) { res.writeHead(404); res.end('{"error":"not_found"}'); return; }
    // Surface the live worker's id so the page can embed /stream/<id> while
    // running. After completion the worker has already moved on, so this
    // becomes null and the UI can hide the stream.
    let streamWorkerId = null;
    if (ex.status === 'running') {
      const w = Array.from(workers.values()).find((ww) => ww.exhibitionId === id);
      streamWorkerId = w ? w.workerId : null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...ex, stream_worker_id: streamWorkerId }));
    return;
  }
  if (req.url === '/api/follow' && req.method === 'GET') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listFollows(db, u.id)));
    return;
  }
  if (req.url === '/api/follow' && req.method === 'POST') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    readJsonBody(req).then((body) => {
      const r = follow(db, u.id, body.kind, Number(body.id));
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  const unfollowMatch = req.url && req.url.match(/^\/api\/follow\/(master|team)\/(\d+)$/);
  if (unfollowMatch && req.method === 'DELETE') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const r = unfollow(db, u.id, unfollowMatch[1], Number(unfollowMatch[2]));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (req.url === '/api/me/wait') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const team = db.prepare('SELECT id, current_league_id FROM team WHERE user_id = ?').get(u.id);
    if (!team) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ waiting: null, reason: 'no_team' })); return;
    }
    if (team.current_league_id) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ waiting: false, league_id: team.current_league_id })); return;
    }
    // ETA: remaining fixtures of the current running league × ~50s per
    // fixture / worker count. Matches the real cadence at 3 workers.
    const running = db.prepare("SELECT id FROM league WHERE status = 'running' ORDER BY id DESC LIMIT 1").get();
    if (!running) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ waiting: true, reason: 'no_running_league' })); return;
    }
    const { n: remaining } = db.prepare(`
      SELECT COUNT(*) AS n FROM fixture f
      JOIN division d ON f.division_id = d.id
      WHERE d.league_id = ? AND f.status != 'complete'
    `).get(running.id);
    // Count real waitlist to give "Nth in queue" colour.
    const ahead = db.prepare(`
      SELECT COUNT(*) AS n FROM team t
      JOIN user_account u ON t.user_id = u.id
      WHERE u.is_bot = 0 AND t.current_league_id IS NULL
        AND (SELECT COUNT(*) FROM owned_fighter WHERE team_id = t.id AND is_retired = 0 AND slot = 'active') >= 5
        AND t.id < ?
    `).get(team.id).n;
    const etaSeconds = Math.round((remaining / Math.max(1, WORKER_COUNT)) * 50);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      waiting: true,
      reason: 'next_season',
      eta_seconds: etaSeconds,
      remaining_fixtures: remaining,
      current_league_id: running.id,
      ahead_in_queue: ahead,
    }));
    return;
  }
  if (req.url === '/api/me/wallet') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const row = db.prepare('SELECT balance_cents FROM user_account WHERE id = ?').get(u.id);
    const recent = db.prepare(
      'SELECT delta_cents, reason, ref_id, created_at FROM wallet_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 15'
    ).all(u.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ balance_cents: row?.balance_cents || 0, recent }));
    return;
  }
  const marketMatch = req.url && req.url.match(/^\/api\/market(?:\?.*)?$/);
  if (marketMatch && req.method === 'GET') {
    const db = getDb();
    const url = new URL(req.url, 'http://x');
    // Pass `?limit=N` to cap; omit (or pass `all`) to return every unclaimed
    // master. Without a cap the response can be 1k+ rows but the JSON is small
    // and the market page already lazy-renders cards as the user scrolls.
    const raw = url.searchParams.get('limit');
    const limit = (!raw || raw === 'all') ? null : Math.max(1, parseInt(raw, 10));
    let rows = marketListings(db, { limit });
    // Surface followed masters at the top so a user's starred fighters are
    // the first thing they see when one finally hits the market.
    const u = currentUser(db, req);
    if (u) {
      const follows = listFollows(db, u.id);
      const followedSet = new Set(follows.masters);
      rows = rows.map((r) => ({ ...r, followed: followedSet.has(r.id) }));
      rows.sort((a, b) => Number(b.followed) - Number(a.followed));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }
  if (req.url === '/api/market/buy' && req.method === 'POST') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    readJsonBody(req).then((data) => {
      const masterId = Number(data.master_fighter_id);
      if (!Number.isInteger(masterId) || masterId <= 0) {
        res.writeHead(400); res.end('{"error":"master_fighter_id required"}'); return;
      }
      const result = buyUnclaimedMaster(db, u.id, masterId);
      const status = result.ok ? 200 : (result.error === 'insufficient_balance' ? 402 : 400);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  const listingsMatch = req.url && req.url.match(/^\/api\/market\/listings(?:\?.*)?$/);
  if (listingsMatch && req.method === 'GET') {
    const db = getDb();
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
    let rows = userListings(db, { limit });
    const u = currentUser(db, req);
    if (u) {
      const followedSet = new Set(listFollows(db, u.id).masters);
      rows = rows.map((r) => ({ ...r, followed: followedSet.has(r.master_id) }));
      rows.sort((a, b) => Number(b.followed) - Number(a.followed));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }
  if (req.url === '/api/market/buy-listing' && req.method === 'POST') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    readJsonBody(req).then((data) => {
      const id = Number(data.owned_fighter_id);
      if (!Number.isInteger(id) || id <= 0) {
        res.writeHead(400); res.end('{"error":"owned_fighter_id required"}'); return;
      }
      const result = buyListedFighter(db, u.id, id);
      const status = result.ok ? 200 : (result.error === 'insufficient_balance' ? 402 : 400);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  const listMatch = req.url && req.url.match(/^\/api\/owned-fighter\/(\d+)\/list-for-sale$/);
  if (listMatch && req.method === 'POST') {
    const id = Number(listMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    readJsonBody(req).then((data) => {
      const price = Number(data.price_cents);
      const result = listForSale(db, u.id, id, price);
      const status = result.ok ? 200 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  const unlistMatch = req.url && req.url.match(/^\/api\/owned-fighter\/(\d+)\/unlist$/);
  if (unlistMatch && req.method === 'POST') {
    const id = Number(unlistMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const result = unlistFromSale(db, u.id, id);
    const status = result.ok ? 200 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  const releaseMatch = req.url && req.url.match(/^\/api\/owned-fighter\/(\d+)\/release$/);
  if (releaseMatch && req.method === 'POST') {
    const id = Number(releaseMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const result = releaseOwnedFighter(db, u.id, id);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  if (req.url === '/api/import/char' && req.method === 'POST') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    readBinaryBody(req).then(async (buf) => {
      if (buf.length < 200) { res.writeHead(400); res.end('{"error":"tiny_upload"}'); return; }
      const tmpPath = `/tmp/mb-upload-${randomUUID().slice(0, 8)}.zip`;
      writeFileSync(tmpPath, buf);
      try {
        const original = (req.headers['x-filename'] || 'upload.zip').toString();
        const result = await importCharFromZip(db, {
          zipPath: tmpPath, originalFilename: original, userId: u.id,
        });
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }
    }).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upload_failed', detail: String(err.message || err).slice(0, 200) }));
    });
    return;
  }
  if (req.url === '/api/me/imports') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listUserImports(db, u.id)));
    return;
  }
  const fighterHistoryMatch = req.url && req.url.match(/^\/api\/owned-fighter\/(\d+)\/history(?:\?.*)?$/);
  if (fighterHistoryMatch && req.method === 'GET') {
    const id = Number(fighterHistoryMatch[1]);
    const db = getDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ownedFighterHistory(db, id, 15)));
    return;
  }
  const teamScheduleMatch = req.url && req.url.match(/^\/api\/team\/(\d+)\/schedule$/);
  if (teamScheduleMatch && req.method === 'GET') {
    const id = Number(teamScheduleMatch[1]);
    const db = getDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(teamSchedule(db, id)));
    return;
  }
  // --- Stage market ---
  if (req.url && req.url.match(/^\/api\/market\/stages(?:\?.*)?$/) && req.method === 'GET') {
    const db = getDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(marketStageListings(db, { limit: 500 })));
    return;
  }
  if (req.url && req.url.match(/^\/api\/market\/stage-listings(?:\?.*)?$/) && req.method === 'GET') {
    const db = getDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(userStageListings(db, { limit: 200 })));
    return;
  }
  if (req.url === '/api/me/home-stage' && req.method === 'GET') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const team = db.prepare('SELECT id FROM team WHERE user_id = ?').get(u.id);
    if (!team) { res.writeHead(200); res.end('null'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getHomeStage(db, team.id)));
    return;
  }
  if (req.url === '/api/market/buy-stage' && req.method === 'POST') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    readJsonBody(req).then((data) => {
      const stageId = Number(data.stage_id);
      if (!Number.isInteger(stageId) || stageId <= 0) {
        res.writeHead(400); res.end('{"error":"stage_id required"}'); return;
      }
      const result = buyUnclaimedStage(db, u.id, stageId);
      const status = result.ok ? 200 : (result.error === 'insufficient_balance' ? 402 : 400);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  if (req.url === '/api/market/buy-stage-listing' && req.method === 'POST') {
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    readJsonBody(req).then((data) => {
      const result = buyListedStage(db, u.id, Number(data.stage_id));
      const status = result.ok ? 200 : (result.error === 'insufficient_balance' ? 402 : 400);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  const stageListMatch = req.url && req.url.match(/^\/api\/stage\/(\d+)\/list-for-sale$/);
  if (stageListMatch && req.method === 'POST') {
    const id = Number(stageListMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    readJsonBody(req).then((data) => {
      const result = listStageForSale(db, u.id, id, Number(data.price_cents));
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  const stageUnlistMatch = req.url && req.url.match(/^\/api\/stage\/(\d+)\/unlist$/);
  if (stageUnlistMatch && req.method === 'POST') {
    const id = Number(stageUnlistMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const result = unlistStage(db, u.id, id);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  const stageReleaseMatch = req.url && req.url.match(/^\/api\/stage\/(\d+)\/release$/);
  if (stageReleaseMatch && req.method === 'POST') {
    const id = Number(stageReleaseMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const result = releaseStage(db, u.id, id);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  const suggestMatch = req.url && req.url.match(/^\/api\/owned-fighter\/(\d+)\/suggested-price$/);
  if (suggestMatch && req.method === 'GET') {
    const id = Number(suggestMatch[1]);
    const db = getDb();
    const price = suggestedPriceForOwned(db, id);
    if (price == null) { res.writeHead(404); res.end('{"error":"not_found"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ price_cents: price }));
    return;
  }
  const teamMatch = req.url && req.url.match(/^\/api\/team\/(\d+)$/);
  if (teamMatch && req.method === 'GET') {
    const team = getTeamById(getDb(), Number(teamMatch[1]));
    if (!team) { res.writeHead(404); res.end('{"error":"team not found"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(team));
    return;
  }
  const lineupMatch = req.url && req.url.match(/^\/api\/team\/(\d+)\/lineup$/);
  if (lineupMatch && req.method === 'PUT') {
    const teamId = Number(lineupMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const owner = db.prepare('SELECT user_id FROM team WHERE id = ?').get(teamId);
    if (!owner) { res.writeHead(404); res.end('{"error":"team not found"}'); return; }
    if (owner.user_id !== u.id) { res.writeHead(403); res.end('{"error":"Not your team"}'); return; }
    readJsonBody(req).then((data) => {
      const result = setLineup(db, teamId, data);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    }).catch((e) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request', detail: String(e.message || e) }));
    });
    return;
  }
  const renameTeamMatch = req.url && req.url.match(/^\/api\/team\/(\d+)\/name$/);
  if (renameTeamMatch && req.method === 'PUT') {
    const teamId = Number(renameTeamMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const owner = db.prepare('SELECT user_id FROM team WHERE id = ?').get(teamId);
    if (!owner || owner.user_id !== u.id) { res.writeHead(403); res.end('{"error":"Not your team"}'); return; }
    readJsonBody(req).then((data) => {
      const name = String(data.name || '').trim();
      if (!name || name.length > 40) {
        res.writeHead(400); res.end('{"error":"name must be 1-40 chars"}'); return;
      }
      db.prepare('UPDATE team SET name = ? WHERE id = ?').run(name, teamId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name }));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  const renameFighterMatch = req.url && req.url.match(/^\/api\/owned-fighter\/(\d+)\/name$/);
  if (renameFighterMatch && req.method === 'PUT') {
    const fighterId = Number(renameFighterMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    const owner = db.prepare(`
      SELECT t.user_id FROM owned_fighter of JOIN team t ON of.team_id = t.id WHERE of.id = ?
    `).get(fighterId);
    if (!owner || owner.user_id !== u.id) { res.writeHead(403); res.end('{"error":"Not your fighter"}'); return; }
    readJsonBody(req).then((data) => {
      const name = String(data.name || '').trim();
      if (!name || name.length > 40) { res.writeHead(400); res.end('{"error":"name must be 1-40 chars"}'); return; }
      db.prepare('UPDATE owned_fighter SET display_name = ? WHERE id = ?').run(name, fighterId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name }));
    }).catch(() => { res.writeHead(400); res.end(); });
    return;
  }
  const aiGetMatch = req.url && req.url.match(/^\/api\/owned-fighter\/(\d+)\/ai$/);
  if (aiGetMatch && req.method === 'GET') {
    const fighterId = Number(aiGetMatch[1]);
    const db = getDb();
    // Public read is fine; anyone can see AI. Restrict later if desired.
    const eff = getEffectiveCmd(db, fighterId);
    if (!eff) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(eff));
    return;
  }
  if (aiGetMatch && req.method === 'PUT') {
    const fighterId = Number(aiGetMatch[1]);
    const db = getDb();
    const u = currentUser(db, req);
    if (!u) { res.writeHead(401); res.end('{"error":"Not signed in"}'); return; }
    // Owner check
    const owner = db.prepare(`
      SELECT t.user_id FROM owned_fighter of JOIN team t ON of.team_id = t.id WHERE of.id = ?
    `).get(fighterId);
    if (!owner) { res.writeHead(404); res.end('{"error":"fighter not found"}'); return; }
    if (owner.user_id !== u.id) { res.writeHead(403); res.end('{"error":"Not your fighter"}'); return; }

    readJsonBody(req).then((data) => {
      try {
        const result = saveCmdOverride(db, fighterId, data.cmd_text);
        if (result.error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      } catch (err) {
        console.error('[PUT /api/owned-fighter/:id/ai]', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error', detail: String(err?.message || err) }));
      }
    }).catch((err) => {
      console.error('[PUT readJsonBody]', err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request', detail: String(err?.message || err) }));
    });
    return;
  }
  const portraitMatch = req.url && req.url.match(/^\/portrait\/([^/]+)\.png$/);
  if (portraitMatch) {
    const name = decodeURIComponent(portraitMatch[1]);
    // Prevent path traversal — only allow the exact char subdir
    if (/[/\\..]/.test(name) || name.includes('..')) {
      res.writeHead(400); res.end('bad name'); return;
    }
    const png = join(CHARS_DIR, name, 'portrait.png');
    if (!existsSync(png)) { res.writeHead(404); res.end('no portrait'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    createReadStream(png).pipe(res);
    return;
  }
  const stagePrevMatch = req.url && req.url.match(/^\/stage-preview\/([^/]+)\.png$/);
  if (stagePrevMatch) {
    const name = decodeURIComponent(stagePrevMatch[1]);
    if (/[/\\..]/.test(name) || name.includes('..')) {
      res.writeHead(400); res.end('bad name'); return;
    }
    const png = join(ROOT, 'engine', 'stage-previews', `${name}.png`);
    if (!existsSync(png)) { res.writeHead(404); res.end('no preview'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    createReadStream(png).pipe(res);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// ---------- boot ----------

// Audio streaming is disabled until we solve OpenAL/PulseAudio routing properly —
// PULSE_SINK didn't actually redirect Ikemen's output. Left the startAudio + /audiostream
// plumbing in place for when we revisit.
(async () => {
  await bootWorkers();
  startSupervisor();
  startExhibitionSupervisor();
  startBotMarketSupervisor();
  server.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
    console.log(`[pool] ${WORKER_COUNT} league worker(s) on displays :${DISPLAY_BASE + 1}..:${DISPLAY_BASE + WORKER_COUNT}`);
    if (EXHIBITION_WORKER_COUNT > 0) {
      const start = DISPLAY_BASE + WORKER_COUNT + 1;
      console.log(`[pool] ${EXHIBITION_WORKER_COUNT} exhibition worker(s) on displays :${start}..:${start + EXHIBITION_WORKER_COUNT - 1}`);
    }
    console.log(`[hint] create leagues with: node src/index.js league create`);
  });
})();

function shutdown() {
  console.log('\n[shutdown]');
  for (const w of workers.values()) w.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
