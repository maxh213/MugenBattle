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
import { getTeamForUser, getTeamById, setLineup } from './teams.js';
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
const SUPERVISOR_POLL_MS = 10_000;
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

  for (let i = 1; i <= WORKER_COUNT; i++) {
    const w = new StreamWorker({
      workerId: i,
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
}

/**
 * Every SUPERVISOR_POLL_MS: for each idle worker, find a running league that
 * isn't already claimed by another worker and assign it. Tidy way to keep the
 * pool busy without manual assignment.
 */
function startSupervisor() {
  setInterval(() => {
    const db = getDb();
    // Track claimed divisions — each worker runs one division of one league.
    const claimedDivs = new Set(
      Array.from(workers.values()).map((w) => w.divisionId).filter((x) => x != null)
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

    for (const w of workers.values()) {
      if (w.status !== 'idle') continue;
      const next = candidates.shift();
      if (!next) break;
      console.log(`[supervisor] league ${next.leagueId} div ${next.divisionId} → worker ${w.workerId}`);
      w.assignLeague(db, next.leagueId, next.divisionId);
    }
  }, SUPERVISOR_POLL_MS);
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
  const recent = db.prepare(`
    SELECT f1.display_name AS f1, f2.display_name AS f2, s.display_name AS stage,
      v.file_name AS victor_file, v.display_name AS victor, fh.fought_at
    FROM fight_history fh
    JOIN fighter f1 ON fh.fighter_one_id = f1.id
    JOIN fighter f2 ON fh.fighter_two_id = f2.id
    JOIN stage s ON fh.stage_id = s.id
    LEFT JOIN fighter v ON fh.victor_id = v.id
    WHERE fh.fighter_one_id = ? OR fh.fighter_two_id = ?
    ORDER BY fh.fought_at DESC LIMIT 15
  `).all(fighter.id, fighter.id);
  const total = fighter.matches_won + fighter.matches_lost + fighter.matches_drawn;
  return {
    ...fighter,
    total_matches: total,
    win_rate: total > 0 ? Math.round(1000 * fighter.matches_won / total) / 10 : 0,
    recent,
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
`;

const MODAL_HTML = `
<div class="modal-bg" id="modal-bg" onclick="if(event.target===this)closeModal()">
  <div class="modal"><div class="modal-shell">
    <div class="close" onclick="closeModal()">×</div>
    <div id="modal-body"></div>
  </div></div>
</div>
<script>
async function openProfile(fileName) {
  const r = await fetch('/api/fighter/' + encodeURIComponent(fileName));
  if (!r.ok) return;
  const f = await r.json();
  const recent = (f.recent || []).map(m => {
    const winLose = m.victor === f.display_name || m.victor_file === f.file_name ? 'W' : (m.victor ? 'L' : 'D');
    const opp = (m.f1 === (f.display_name || f.file_name)) ? m.f2 : m.f1;
    return \`<tr><td>\${winLose}</td><td>vs \${esc(opp)}</td><td style="color:#8b949e">\${esc(m.stage || '')}</td></tr>\`;
  }).join('');
  document.getElementById('modal-body').innerHTML = \`
    <div class="head">
      <img class="portrait" src="/portrait/\${encodeURIComponent(f.file_name)}.png" onerror="this.style.visibility='hidden'">
      <div>
        <h3>\${esc(f.display_name || f.file_name)}</h3>
        <div class="sub">\${esc(f.author || 'unknown author')}</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">\${f.matches_won}</div><div class="l">Wins</div></div>
      <div class="stat"><div class="v">\${f.matches_lost}</div><div class="l">Losses</div></div>
      <div class="stat"><div class="v">\${f.matches_drawn}</div><div class="l">Draws</div></div>
      <div class="stat"><div class="v">\${f.win_rate}%</div><div class="l">Win rate</div></div>
    </div>
    <div class="field"><b>File name:</b> \${esc(f.file_name)}</div>
    <div class="field"><b>Added:</b> \${esc(f.created_at || '-')}</div>
    \${f.source_url ? \`<div class="field"><b>Source:</b> <a href="\${esc(f.source_url)}" target="_blank">\${esc(f.source_url)}</a></div>\` : ''}
    \${f.validation_reason ? \`<div class="field"><b>Issue:</b> <span style="color:#f85149">\${esc(f.validation_reason)}</span></div>\` : ''}
    \${recent ? \`<h2 style="margin-top:16px;font-size:12px;text-transform:uppercase;color:#8b949e">Recent fights</h2><table>\${recent}</table>\` : ''}
  \`;
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
      '<div class="k"><span class="swatch champion"></span>Champion (tier 1 #1)</div>' +
      '<div class="k"><span class="swatch promote"></span>Promotion (top ' + K + ')</div>' +
      '<div class="k"><span class="swatch relegate"></span>Relegation (bottom ' + K + ')</div>' +
      '<div class="k"><span class="swatch drop"></span>Drop &amp; sit out (bottom ' + K + ' of bottom tier)</div>' +
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
        '<span class="tier-n">Tier ' + d.tier + '</span>' +
        '<span class="tname">' + esc(d.name) + '</span>' +
      '</div>' +
      '<div class="rows">' + rowsHtml + '</div>' +
    '</div>';
  }).join('');

  root.innerHTML = header + tiers +
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

<h2 style="font-size:14px;margin:20px 0 8px;color:#8b949e;text-transform:uppercase;letter-spacing:0.4px">Unclaimed masters</h2>
<div class="market-controls">
  <input type="search" id="q" placeholder="Search by name or author…">
  <select id="sort">
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
    fetch('/api/market?limit=500').then(r => r.json()),
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
    if (sort === 'price_asc') return a.price_cents - b.price_cents || (a.display_name||'').localeCompare(b.display_name||'');
    if (sort === 'price_desc') return b.price_cents - a.price_cents;
    if (sort === 'wins_desc') return b.matches_won - a.matches_won;
    return (a.display_name || a.file_name || '').localeCompare(b.display_name || b.file_name || '');
  });
  document.getElementById('count').textContent = rows.length + ' available';
  document.getElementById('grid').innerHTML = rows.slice(0, 400).map(cardHtml).join('');
}

function cardHtml(m) {
  const canBuy = !!(me && me.authenticated && !me.needs_username);
  return '<div class="market-card" data-id="' + m.id + '">' +
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
  .wallet-row { display: flex; gap: 18px; align-items: center; padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 14px; }
  .wallet-row .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  .wallet-row .balance { font-size: 20px; font-weight: 600; color: #3fb950; font-variant-numeric: tabular-nums; }
  .wallet-row .market-link { margin-left: auto; background: transparent; color: #58a6ff; border: 1px solid #58a6ff; padding: 6px 14px; border-radius: 6px; font-size: 13px; text-decoration: none; }
  .wallet-row .market-link:hover { background: #58a6ff; color: #0d1117; }
  .team-header { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; padding: 14px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; }
  .rotate-panel { padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 14px; }
  .rotate-row { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .rotate-row .rotate-label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: #c9d1d9; cursor: pointer; font-weight: 600; }
  .rotate-row .rotate-label input { width: 16px; height: 16px; cursor: pointer; }
  .rotate-config { margin-top: 12px; padding-top: 12px; border-top: 1px solid #21262d; }
  .rotate-config.disabled { opacity: 0.4; pointer-events: none; }
  .rotate-slider-row { display: grid; grid-template-columns: auto 1fr 60px; gap: 12px; align-items: center; margin-bottom: 8px; }
  .rotate-slider-row label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
  .rotate-slider-row input[type=range] { accent-color: #58a6ff; }
  .rotate-threshold-val { text-align: right; color: #f0ae3c; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 15px; }
  .rotate-hint { color: #8b949e; font-size: 11px; line-height: 1.5; }
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
  .schedule-row { display: grid; grid-template-columns: 60px 1.5fr 50px 1.5fr 70px 70px; gap: 10px; padding: 8px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; font-size: 12px; margin-bottom: 4px; align-items: center; font-variant-numeric: tabular-nums; }
  .schedule-row .sched-round { color: #8b949e; }
  .schedule-row .sched-team { text-align: left; }
  .schedule-row .sched-team.away { text-align: right; }
  .schedule-row .sched-team .us { color: #58a6ff; font-weight: 600; }
  .schedule-row .sched-vs { color: #6e7681; text-align: center; }
  .schedule-row .sched-score { color: #f0ae3c; font-weight: 600; text-align: center; }
  .schedule-row .sched-score.loss { color: #f85149; }
  .schedule-row .sched-score.win { color: #3fb950; }
  .schedule-row .sched-score.draw { color: #8b949e; }
  .schedule-row .sched-status { color: #6e7681; font-size: 11px; text-align: right; text-transform: uppercase; letter-spacing: 0.4px; }
  .schedule-row .sched-status.done { color: #3fb950; }
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
  <a href="/leaderboard">Leaderboard</a>
</nav>

<div id="signed-out" class="empty-state" style="display:none">
  <h2>Sign in to manage your team</h2>
  <p>Use the "Sign in" button in the top right to get a one-time code.</p>
</div>

<div id="team-root" style="display:none">
  <div id="wait-banner" class="wait-banner" style="display:none"></div>
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
        <span>Auto-rotate tired fighters</span>
      </label>
      <span class="msg" id="rotate-msg"></span>
    </div>
    <div class="rotate-config" id="rotate-config">
      <div class="rotate-slider-row">
        <label for="rotate-threshold">Swap when stamina drops below</label>
        <input type="range" id="rotate-threshold" min="0" max="1" step="0.05" value="0.30" oninput="updateThresholdLabel()" onchange="saveRotation()">
        <span class="rotate-threshold-val" id="rotate-threshold-val">0.30</span>
      </div>
      <div class="rotate-hint">
        Threshold <b>0.00</b> = never swap (equivalent to turning auto-rotate off).
        <b>1.00</b> = always prefer the freshest bench fighter.
        <b>0.30</b> (default) kicks in when a fighter is roughly one match away from empty.
        <br>
        Stamina drops <b>0.20</b> per match played and recovers <b>0.10 per hour</b> of rest.
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
      ? 'You\\'re first in the queue — guaranteed a seat in the next season\\'s bottom tier.'
      : ahead + ' real player' + (ahead === 1 ? '' : 's') + ' ahead of you in the queue.';
    host.innerHTML =
      '<div class="head">Waiting for next league</div>' +
      'Your team will join the next league when the current one finishes — estimated <span class="eta">' + eta + '</span> from now.' +
      '<div class="meta">' + queueMsg + ' New signups take bot slots first, so if the bottom tier has room you\\'ll take a bot\\'s seat; otherwise you wait one cycle and come in at the NEXT season.</div>';
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
    let score = '—';
    let scoreCls = '';
    let statusLabel = isUpcoming ? f.status : 'complete';
    let statusCls = isUpcoming ? '' : 'done';
    if (f.status === 'complete') {
      score = f.home_score + '–' + f.away_score;
      if (f.winner_team_id === currentTeam.id) scoreCls = 'win';
      else if (f.winner_team_id == null) scoreCls = 'draw';
      else scoreCls = 'loss';
    }
    return '<div class="schedule-row">' +
      '<div class="sched-round">T' + f.tier + ' · R' + f.round_num + '.' + f.slot_num + '</div>' +
      '<div class="sched-team"><span class="' + homeCls.trim() + '">' + esc(f.home_name) + '</span></div>' +
      '<div class="sched-vs">vs</div>' +
      '<div class="sched-team away"><span class="' + awayCls.trim() + '">' + esc(f.away_name) + '</span></div>' +
      '<div class="sched-score ' + scoreCls + '">' + score + '</div>' +
      '<div class="sched-status ' + statusCls + '">' + esc(statusLabel) + '</div>' +
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

function renderTeam() {
  const t = currentTeam;
  document.getElementById('team-name').value = t.name || '';
  const ar = document.getElementById('auto-rotate');
  if (ar) ar.checked = !!t.auto_rotate;
  const slider = document.getElementById('rotate-threshold');
  if (slider) {
    slider.value = (t.rotation_threshold != null ? t.rotation_threshold : 0.30).toFixed(2);
    updateThresholdLabel();
    document.getElementById('rotate-config').classList.toggle('disabled', !t.auto_rotate);
  }
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

function updateThresholdLabel() {
  const slider = document.getElementById('rotate-threshold');
  if (!slider) return;
  document.getElementById('rotate-threshold-val').textContent = Number(slider.value).toFixed(2);
}

async function saveRotation() {
  const on = document.getElementById('auto-rotate').checked;
  const threshold = Number(document.getElementById('rotate-threshold').value);
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
    body: JSON.stringify({ active, bench, priority, auto_rotate: on, rotation_threshold: threshold }),
  });
  if (r.ok) {
    currentTeam.auto_rotate = on ? 1 : 0;
    currentTeam.rotation_threshold = threshold;
    msg.className = 'msg ok';
    msg.textContent = on ? 'rotate @ ' + threshold.toFixed(2) : 'auto-rotate off';
  } else {
    const body = await r.json().catch(() => ({}));
    msg.className = 'msg err'; msg.textContent = body.error || 'error';
  }
  setTimeout(() => { msg.textContent = ''; }, 2200);
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
      '<div class="sub">Master: ' + esc(f.master_display_name || f.master_file_name) + ' · ' + esc(f.slot) + ' · priority ' + f.priority + '</div></div>' +
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
    'AI &middot; ' + (ai.source === 'override' ? 'your override v' + ai.version : 'stock master');
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
  .worker .meta { color: #8b949e; font-size: 11px; display: flex; gap: 12px; flex-wrap: wrap; }
  .worker .fighters { font-size: 12px; color: #c9d1d9; margin: 4px 0 6px; }
  .worker .fighters .vs { color: #6e7681; margin: 0 6px; }
  .worker .wid { color: #6e7681; font-size: 10px; text-transform: uppercase; }
  .empty-state { text-align: center; padding: 40px 20px; color: #6e7681; background: #161b22; border: 1px dashed #30363d; border-radius: 10px; }
</style></head>
<body style="position:relative">
${AUTH_BAR_HTML}
<h1>📺 Live Leagues</h1>
<nav>
  <a href="/">Live (tournament)</a>
  <a href="/leagues" class="active">Leagues</a>
  <a href="/pyramid">Pyramid</a>
  <a href="/team">My Team</a>
  <a href="/market">Market</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>
<div id="workers"></div>
<script>
function esc(s){return String(s==null?'':s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}
function overlayHtml(w) {
  const ctx = w.context;
  if (!ctx || !ctx.fixture) {
    const msg = ctx && ctx.league
      ? 'Between fixtures (' + esc(ctx.league.name) + ')'
      : w.status === 'idle' ? 'Waiting for a league…' : 'Starting up…';
    return '<div class="meta">' + esc(msg) + '</div>';
  }
  const f = ctx.fixture;
  const fighterLine = (f.home_fighter && f.away_fighter)
    ? '<div class="fighters">' + esc(f.home_fighter) + ' <span class="vs">vs</span> ' + esc(f.away_fighter) + '</div>'
    : '';
  return (
    '<div class="hdr">' +
      '<span class="lname">' + esc(ctx.league.name) + '</span>' +
      '<span class="tier">Tier ' + f.division.tier + ' · ' + esc(f.division.name) + '</span>' +
    '</div>' +
    '<div class="matchup">' +
      esc(f.home_team) +
      '<span class="score">' + f.home_rounds + ' – ' + f.away_rounds + '</span>' +
      esc(f.away_team) +
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

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MugenBattle Live</title>
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...data, viewer_team_id: viewerTeamId }));
    return;
  }
  if (req.url === '/api/workers') {
    const db = getDb();
    const data = Array.from(workers.values()).map((w) => {
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(team || { error: 'No team yet' }));
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
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(marketListings(db, { limit })));
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(userListings(db, { limit })));
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
  server.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
    console.log(`[pool] ${WORKER_COUNT} worker(s) on displays :${DISPLAY_BASE + 1}..:${DISPLAY_BASE + WORKER_COUNT}`);
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
