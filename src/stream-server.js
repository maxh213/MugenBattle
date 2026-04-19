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
 *   STREAM_PORT         HTTP port (default 8080)
 *   STREAM_WORKERS      parallel worker count (default 1)
 *   STREAM_DISPLAY_BASE base for worker X displays (default 99 → :100+i)
 *   STREAM_SIZE         capture resolution (default 640x480)
 *   STREAM_FPS          capture framerate (default 15)
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
import { getLiveLeagueContext, getStandings, latestInterestingLeagueId } from './leagues.js';
import {
  marketListings,
  buyUnclaimedMaster,
  suggestedPriceForOwned,
  listForSale,
  unlistFromSale,
  buyListedFighter,
  userListings,
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

// ---------- Worker pool ----------

/** workerId → StreamWorker. workerId is 1-indexed for URL friendliness. */
const workers = new Map();
const audioClients = new Set();
const PULSE_SOURCE = process.env.STREAM_AUDIO_SOURCE || 'mugenbattle.monitor';
let audioFfmpeg;

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
    const claimed = new Set(
      Array.from(workers.values()).map((w) => w.leagueId).filter((x) => x != null)
    );
    const leagues = db.prepare(`
      SELECT id FROM league WHERE status = 'running' ORDER BY id
    `).all();
    for (const w of workers.values()) {
      if (w.status !== 'idle') continue;
      const next = leagues.find((l) => !claimed.has(l.id));
      if (!next) break;
      claimed.add(next.id);
      console.log(`[supervisor] assigning league ${next.id} → worker ${w.workerId}`);
      w.assignLeague(db, next.id);
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
  .prow { display: grid; grid-template-columns: 30px 2.4fr 50px 50px 50px 70px 60px; gap: 8px; padding: 8px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; align-items: center; font-size: 13px; font-variant-numeric: tabular-nums; }
  .prow.mine { border-color: #58a6ff; background: #1d2a3e; }
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
  const statusCls = data.league.status;
  const header =
    '<div class="league-hdr">' +
      '<span class="name">' + esc(data.league.name) + '</span>' +
      '<span class="status ' + statusCls + '">' + statusCls + '</span>' +
      (data.pending > 0 ? '<span class="pending">' + data.pending + ' fixtures pending</span>' : '') +
    '</div>';

  const tiers = data.divisions.map((d, i) => {
    const rowsHtml = d.standings.map((s, idx) => {
      const diff = s.matches_won - s.matches_lost;
      const diffCls = diff > 0 ? 'pos' : diff < 0 ? 'neg' : '';
      const isMine = data.viewer_team_id === s.team_id;
      const badge = isMine
        ? '<span class="badge me">you</span>'
        : s.username && s.username.startsWith('bot_')
          ? '<span class="badge bot">bot</span>'
          : '';
      return '<div class="prow' + (isMine ? ' mine' : '') + ' pos-' + (idx + 1) + '">' +
        '<div class="pos">' + (idx + 1) + '</div>' +
        '<div class="tname">' + esc(s.team_name) + badge +
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
  const [m, listings] = await Promise.all([
    fetch('/api/market?limit=500').then(r => r.json()),
    fetch('/api/market/listings?limit=200').then(r => r.json()),
  ]);
  all = m;
  renderListings(listings);
  render();
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
  .wallet-row { display: flex; gap: 18px; align-items: center; padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 14px; }
  .wallet-row .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  .wallet-row .balance { font-size: 20px; font-weight: 600; color: #3fb950; font-variant-numeric: tabular-nums; }
  .wallet-row .market-link { margin-left: auto; background: transparent; color: #58a6ff; border: 1px solid #58a6ff; padding: 6px 14px; border-radius: 6px; font-size: 13px; text-decoration: none; }
  .wallet-row .market-link:hover { background: #58a6ff; color: #0d1117; }
  .team-header { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; padding: 14px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 10px; }
  .team-header label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  .team-header input { flex: 1; background:#0d1117; border:1px solid #30363d; color:#c9d1d9; padding: 8px 12px; border-radius: 6px; font-size: 16px; font-weight: 600; }
  .team-header button { background:#238636; color:white; border:1px solid #2ea043; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .team-header button:hover { background:#2ea043; }
  .team-header .msg { font-size: 12px; min-width: 60px; }
  .team-header .msg.ok { color: #3fb950; }
  .team-header .msg.err { color: #f85149; }
  .roster-section { margin-bottom: 18px; }
  .roster-section h2 { font-size: 12px; text-transform: uppercase; color: #8b949e; margin: 0 0 8px; letter-spacing: 0.4px; }
  .fighter-row { display: grid; grid-template-columns: 20px 2fr 2fr 1fr 0.8fr 0.6fr; gap: 12px; padding: 12px 14px; align-items: center; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 6px; cursor: pointer; transition: border-color 0.1s, opacity 0.1s; }
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
}

function renderFighter(f) {
  const master = f.master_display_name || f.master_file_name || '—';
  const stam = Number(f.stamina || 0).toFixed(2);
  const right = f.slot === 'for_sale' && f.listing_price_cents != null
    ? '<div class="fr-stam" style="color:#f0ae3c;font-weight:600">' + fmtCents(f.listing_price_cents) + '</div>'
    : '<div class="fr-stam">stamina ' + stam + '</div>';
  const dragAttrs = f.slot === 'for_sale' ? '' : ' draggable="true"';
  return '<div class="fighter-row"' + dragAttrs + ' data-fid="' + f.id + '" data-slot="' + esc(f.slot) + '"' +
    ' ondragstart="dragStart(event,' + f.id + ')" ondragover="dragOver(event)"' +
    ' ondragenter="dragEnter(event)" ondragleave="dragLeave(event)"' +
    ' ondrop="dropOn(event,' + f.id + ')" ondragend="dragEnd(event)"' +
    ' onclick="maybeOpenEditor(event,' + f.id + ')">' +
    '<div class="fr-grip">⋮⋮</div>' +
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

  // Swap slots + priorities. Keeps "exactly 5 active, 0..2 bench" because
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
  document.getElementById('edit-body').innerHTML =
    '<h3>' + esc(f.display_name) + '</h3>' +
    '<div class="sub">Master: ' + esc(f.master_display_name || f.master_file_name) + ' · ' + esc(f.slot) + ' · priority ' + f.priority + '</div>' +
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
    '</div>';
  document.getElementById('edit-bg').classList.add('open');
  await renderSellSection(f);

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
    host.innerHTML = '<label>Market</label><span style="color:#6e7681;font-size:12px">Bench this fighter first to list it for sale.</span>';
    return;
  }
  if (f.slot === 'for_sale') {
    const price = Number(f.listing_price_cents || 0);
    host.innerHTML =
      '<label>Market</label>' +
      '<span style="font-size:13px">Listed at <b>' + fmtCents(price) + '</b></span>' +
      '<button onclick="unlistFighter(' + f.id + ')">Unlist</button>' +
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
    '<span class="msg" id="edit-sell-msg"></span>';
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
  .worker .slots { display: flex; gap: 4px; margin-top: 8px; }
  .worker .chip { font-size: 10px; width: 20px; height: 20px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; background: #0d1117; color: #6e7681; border: 1px solid #21262d; font-weight: 600; }
  .worker .chip.h { background: #0f3d1c; color: #3fb950; border-color: #1f6d35; }
  .worker .chip.a { background: #3d0f0f; color: #f85149; border-color: #6d1f1f; }
  .worker .chip.d { background: #1d2a3a; color: #58a6ff; border-color: #2b4660; }
  .worker .chip.live { background: #3d2d0f; color: #f0ae3c; border-color: #6d501f; animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }
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
function chipFor(slotRow, idx, cur) {
  if (!slotRow) {
    if (idx === cur) return '<span class="chip live">' + idx + '</span>';
    return '<span class="chip">' + idx + '</span>';
  }
  const cls = slotRow.winner === 'home' ? 'h' : slotRow.winner === 'away' ? 'a' : 'd';
  const label = slotRow.winner === 'home' ? 'H' : slotRow.winner === 'away' ? 'A' : '·';
  return '<span class="chip ' + cls + '">' + label + '</span>';
}
function render(workers) {
  const root = document.getElementById('workers');
  if (!workers.length) {
    root.innerHTML = '<div class="empty-state">No workers running.</div>';
    return;
  }
  const running = workers.filter(w => w.status !== 'stopped');
  root.className = 'workers';
  root.innerHTML = running.map(w => {
    const ctx = w.context;
    const streamHtml = '<div class="stream"><img src="/stream/' + w.workerId + '?t=' + Date.now() + '"></div>';
    if (!ctx || !ctx.fixture) {
      const msg = ctx && ctx.league
        ? 'Between fixtures (' + esc(ctx.league.name) + ')'
        : w.status === 'idle' ? 'Waiting for a league…' : 'Starting up…';
      return (
        '<div class="worker">' + streamHtml +
        '<div class="overlay">' +
          '<div class="hdr"><span class="wid">Worker #' + w.workerId + ' · ' + esc(w.display) + '</span></div>' +
          '<div class="meta">' + esc(msg) + '</div>' +
        '</div></div>'
      );
    }
    const f = ctx.fixture;
    const chips = [];
    for (let i = 1; i <= 5; i++) {
      const row = f.slots.find(s => s.slot === i);
      chips.push(chipFor(row, i, f.current_slot));
    }
    return (
      '<div class="worker">' + streamHtml +
      '<div class="overlay">' +
        '<div class="hdr">' +
          '<span class="lname">' + esc(ctx.league.name) + '</span>' +
          '<span class="tier">Tier ' + f.division.tier + ' · ' + esc(f.division.name) + '</span>' +
        '</div>' +
        '<div class="matchup">' +
          esc(f.home_team) +
          '<span class="score">' + f.home_score + ' – ' + f.away_score + '</span>' +
          esc(f.away_team) +
        '</div>' +
        '<div class="meta">' +
          '<span>R' + f.round + '.' + f.slot_num + '</span>' +
          (f.stage ? '<span>Stage: ' + esc(f.stage) + '</span>' : '') +
          '<span class="wid">Worker #' + w.workerId + '</span>' +
        '</div>' +
        '<div class="slots">' + chips.join('') + '</div>' +
      '</div></div>'
    );
  }).join('');
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
      const ctx = w.leagueId ? getLiveLeagueContext(db, w.leagueId) : null;
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
