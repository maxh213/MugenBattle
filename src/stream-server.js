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

let xvfb, ffmpeg;
const frameBuffer = { data: null, ts: 0 };  // latest JPEG frame
const clients = new Set();

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
  .stream-wrap { max-width: 1280px; margin: 0 auto; }
  .stream { background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 4 / 3; }
  .stream img { width: 100%; height: 100%; object-fit: contain; display: block; image-rendering: pixelated; }
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
  .see-all { display: block; text-align: right; font-size: 11px; color: #58a6ff; margin-top: 6px; }
</style>
</head>
<body>
<h1>🥊 MugenBattle Live</h1>
<nav>
  <a href="/" class="active">Live</a>
  <a href="/leaderboard">Leaderboard</a>
</nav>
<div class="grid">
  <div class="stream-wrap">
    <div class="stream"><img src="/stream" alt="live"></div>
    <div class="info">
      <div class="match" id="match-info">No active match</div>
      <div class="tourney" id="tourney-info"></div>
    </div>
  </div>
  <div class="sidebar">
    <div class="panel" id="bracket-panel">
      <h2>Bracket</h2>
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
<script>
async function refresh() {
  try {
    const r = await fetch('/api/state'); const s = await r.json();
    document.getElementById('match-info').innerHTML = s.match
      ? \`<strong>\${link(s.match.f1, s.match.f1_fn)}</strong> vs <strong>\${link(s.match.f2, s.match.f2_fn)}</strong>  ·  \${esc(s.match.stage)}\${s.match.round ? '  ·  round ' + s.match.round : ''}\`
      : 'Idle';
    document.getElementById('tourney-info').textContent = s.tournament
      ? \`Tournament #\${s.tournament.id} · \${s.tournament.name || ''} · size \${s.tournament.size}\`
      : '';
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
function link(label, fileName) {
  if (!fileName) return esc(label || '');
  return \`<span class="name-link" onclick="openProfile('\${esc(fileName).replace(/'/g,"\\\\'")}')">\${esc(label || fileName)}</span>\`;
}
function renderBracket(t) {
  const byRound = {};
  for (const m of t.matches) (byRound[m.round] ||= []).push(m);
  const rounds = Math.log2(t.size);
  const names = { 2: 'Final', 4: 'Semis', 8: 'Quarters' };
  let out = '';
  for (let r = 1; r <= rounds; r++) {
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
    // Send most recent frame immediately if available
    if (frameBuffer.data) {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.data.length}\r\n\r\n`);
      res.write(frameBuffer.data);
      res.write('\r\n');
    }
    req.on('close', () => clients.delete(res));
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
