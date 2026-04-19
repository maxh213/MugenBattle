#!/usr/bin/env node
/**
 * Live match streaming server.
 *
 * - Spawns a long-running Xvfb + ffmpeg capturing display :99 as MJPEG.
 * - Serves an HTML dashboard at http://localhost:8080.
 * - Streams video at /stream (multipart MJPEG, plays in any <img>).
 * - Reads current-match state from /tmp/mugenbattle-match-state.json (written by
 *   brackets.js / tournament.js when --stream is passed).
 * - Surfaces bracket + leaderboard state from the SQLite DB.
 *
 * Usage:
 *   node src/stream-server.js
 *   (in another shell) node src/index.js tournament start --size 8 --stream
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CHARS_DIR = join(ROOT, 'engine', 'chars');
const STATE_FILE = '/tmp/mugenbattle-match-state.json';

const PORT = parseInt(process.env.STREAM_PORT || '8080', 10);
const DISPLAY = process.env.STREAM_DISPLAY || ':99';
// Default to Ikemen's native 640x480 so the captured image is 1:1 (no padding).
// Can override with STREAM_SIZE env if you reconfigure engine/save/config.json.
const SIZE = process.env.STREAM_SIZE || '640x480';
const FPS = parseInt(process.env.STREAM_FPS || '15', 10);

// ---------- Xvfb + ffmpeg lifecycle ----------

let xvfb, ffmpeg, audioFfmpeg;
const frameBuffer = { data: null, ts: 0 };  // latest JPEG frame
const clients = new Set();
const audioClients = new Set();
const PULSE_SOURCE = process.env.STREAM_AUDIO_SOURCE || 'mugenbattle.monitor';

function startXvfb() {
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', `${SIZE}x24`, '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });
  xvfb.on('exit', (code) => {
    console.error(`[xvfb] exited with code ${code}`);
    xvfb = null;
  });
  console.log(`[xvfb] started on ${DISPLAY} at ${SIZE}`);
  // Park the default X cursor off-screen so the ✕ glyph doesn't show in the capture.
  setTimeout(() => {
    try {
      spawn('xdotool', ['mousemove', '9999', '9999'], {
        env: { ...process.env, DISPLAY },
        stdio: 'ignore',
      });
    } catch {}
  }, 1000);
}

function startFfmpeg() {
  // -f mpjpeg outputs HTTP-style multipart JPEG that we can parse per frame.
  ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'x11grab',
    '-draw_mouse', '0',   // don't include the X cursor in the captured frames
    '-framerate', String(FPS),
    '-video_size', SIZE,
    '-i', `${DISPLAY}.0`,
    '-c:v', 'mjpeg',
    '-q:v', '5',
    '-f', 'mpjpeg',
    '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Parse mpjpeg: frames separated by boundary lines starting with "--"
  // Simpler: detect JPEG SOI (0xFFD8) and EOI (0xFFD9).
  let buf = Buffer.alloc(0);
  ffmpeg.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi < 0) { buf = Buffer.alloc(0); break; }
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
      if (eoi < 0) {
        if (soi > 0) buf = buf.slice(soi);
        break;
      }
      const frame = buf.slice(soi, eoi + 2);
      buf = buf.slice(eoi + 2);
      frameBuffer.data = frame;
      frameBuffer.ts = Date.now();
      // Broadcast to all streaming clients
      for (const c of clients) {
        try {
          c.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
          c.write(frame);
          c.write('\r\n');
        } catch {}
      }
    }
  });
  ffmpeg.stderr.on('data', (d) => process.stderr.write(`[ffmpeg] ${d}`));
  ffmpeg.on('exit', (code) => {
    console.error(`[ffmpeg] exited with code ${code}`);
    ffmpeg = null;
  });
  console.log(`[ffmpeg] capturing ${DISPLAY} at ${SIZE}@${FPS}`);
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
<div class="auth-bar" id="auth-bar"></div>
<h1>🥊 MugenBattle Live</h1>
<nav>
  <a href="/" class="active">Live</a>
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
</div>
<script>
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
      openAuth(); // nudge them into finishing signup
      _showAuthStep('username');
    } else {
      bar.innerHTML = '<span class="user-email">' + _escAuth(me.username) + '</span>' +
        '<button class="logout" onclick="authLogout()">Sign out</button>';
    }
  } else {
    bar.innerHTML = '<button onclick="openAuth()">Sign in</button>';
  }
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
</script>
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 16_384) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); }
      catch (e) { reject(e); }
    });
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
  if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
      'Connection': 'close',
    });
    clients.add(res);
    if (frameBuffer.data) {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.data.length}\r\n\r\n`);
      res.write(frameBuffer.data);
      res.write('\r\n');
    }
    req.on('close', () => clients.delete(res));
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

startXvfb();
setTimeout(startFfmpeg, 1500);
// Audio streaming is disabled until we solve OpenAL/PulseAudio routing properly —
// PULSE_SINK didn't actually redirect Ikemen's output. Left the startAudio + /audiostream
// plumbing in place for when we revisit.
server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[hint] run tournaments with: DISPLAY=${DISPLAY} node src/index.js tournament start --size 8 --stream`);
});

function shutdown() {
  console.log('\n[shutdown]');
  clients.forEach(c => { try { c.end(); } catch {} });
  if (ffmpeg) ffmpeg.kill('SIGTERM');
  if (xvfb) xvfb.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
