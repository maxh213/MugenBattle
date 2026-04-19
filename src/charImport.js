/**
 * Character import pipeline.
 *
 * User uploads a .zip → extract → inspect shape → move into engine/chars/ →
 * static validator → sandbox test match (vs KFM on a throwaway Xvfb) →
 * insert fighter row. On any failure we roll back (delete the installed
 * dir) and record `status='rejected'` with a reason in character_import.
 *
 * Safety caveats for v1:
 *   - Extraction uses `unzip` (Info-ZIP 6.x); modern builds reject `..`
 *     path traversal by default.
 *   - The sandbox match still runs arbitrary user-controlled .cmd/.cns
 *     inside our Ikemen process. Long-term this belongs in a container or
 *     a separate user — for now we accept the risk.
 *   - No virus scan yet; single-machine dev deploy only.
 *
 * Caller must ensure zipPath is on a trusted filesystem (we don't chase
 * symlinks out of the zip — unzip handles that).
 */

import { spawn } from 'child_process';
import {
  createHash,
  randomUUID,
} from 'crypto';
import {
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { resolve, dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { validateFighter } from './validator.js';
import { runMatch } from './match.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CHARS_DIR = join(PROJECT_ROOT, 'engine', 'chars');
const TMP_ROOT = '/tmp';

const MAX_ZIP_BYTES = 100 * 1024 * 1024;      // upload size cap (compressed)
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024; // zip-bomb cap (uncompressed, total)
const MAX_FILE_BYTES = 50 * 1024 * 1024;       // per-file cap
const SANDBOX_DISPLAY_BASE = 300;
const SANDBOX_LOG_MAX_CHARS = 8_000;

/**
 * Extensions that have no business inside a MUGEN character zip. Hits here
 * trip an immediate rejection — no further scanning needed. Intentionally
 * denylist-based (not allowlist) because MUGEN chars pack a long tail of
 * legitimate file types: sprites, sounds, palettes, readmes, fonts, etc.
 */
const DISALLOWED_EXTS = new Set([
  'exe', 'dll', 'so', 'dylib', 'msi', 'app', 'deb', 'rpm', 'scr', 'lnk', 'desktop',
  'bat', 'ps1', 'vbs', 'sh', 'bash', 'zsh', 'command',
  'js', 'mjs', 'cjs', 'py', 'rb', 'pl', 'php', 'jar',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg',
]);

let clamScanProbed = false;
let clamScanAvailable = false;

function sha256File(path) {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

function runShell(cmd, args, opts = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    // 'close' fires after stdio is drained — 'exit' can land before the
    // last stdout chunks arrive, which dropped the signature name on the
    // floor for fast-exiting tools like clamscan.
    child.on('close', (code) => {
      if (code === 0) { resolveP({ stdout, stderr }); return; }
      const err = new Error(`${cmd} exited ${code}: ${(stdout || stderr).slice(0, 400)}`);
      err.stdout = stdout;
      err.stderr = stderr;
      err.exitCode = code;
      reject(err);
    });
    child.on('error', reject);
  });
}

/**
 * Extract zip into a fresh temp dir. Returns the dir path. Uses Info-ZIP
 * unzip which rejects paths with `..` by default.
 */
async function extractZip(zipPath) {
  const dest = join(TMP_ROOT, `mb-import-${randomUUID().slice(0, 8)}`);
  mkdirSync(dest);
  await runShell('unzip', ['-qq', '-d', dest, zipPath]);
  return dest;
}

/**
 * Scan the extract dir to find a char subdirectory. Expected shape:
 * exactly one top-level directory containing `<name>/<name>.def`. Returns
 * { charDir, fileName } or { error, reason }.
 */
function findCharDir(extractDir) {
  const entries = readdirSync(extractDir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !e.name.startsWith('__MACOSX'));
  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => e.isFile());

  // Flat zip: all files at top level, no subdirectory.
  if (dirs.length === 0 && files.length > 0) {
    const def = files.find((f) => /\.def$/i.test(f.name));
    if (!def) return { error: 'no_def_at_root' };
    const name = def.name.replace(/\.def$/i, '');
    return { charDir: extractDir, fileName: name };
  }

  // Single-subdir zip (the common case).
  if (dirs.length === 1 && files.length === 0) {
    const charDir = join(extractDir, dirs[0].name);
    const fileName = dirs[0].name;
    const defPath = join(charDir, `${fileName}.def`);
    if (!existsSync(defPath)) return { error: 'missing_def_matching_dirname', expected: `${fileName}.def` };
    return { charDir, fileName };
  }

  return { error: 'ambiguous_zip_shape', dirs: dirs.length, files: files.length };
}

function isValidFileName(name) {
  return /^[A-Za-z0-9_.\- ]{1,64}$/.test(name) && !name.includes('..');
}

/**
 * Walk the extracted tree checking for disallowed extensions, per-file
 * size cap, and total-size cap (zip-bomb protection). Returns { ok } or
 * { error, reason }.
 */
function scanExtractedTree(extractDir) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const r = walk(full);
        if (r && r.error) return r;
        continue;
      }
      if (!entry.isFile()) continue;  // symlinks etc — skip
      const stat = statSync(full);
      if (stat.size > MAX_FILE_BYTES) {
        return { error: 'file_too_large', reason: `${entry.name} is ${stat.size} bytes (cap ${MAX_FILE_BYTES})` };
      }
      total += stat.size;
      if (total > MAX_EXTRACTED_BYTES) {
        return { error: 'extracted_too_large', reason: `total > ${MAX_EXTRACTED_BYTES} bytes (zip bomb?)` };
      }
      const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
      if (DISALLOWED_EXTS.has(ext)) {
        return { error: 'disallowed_extension', reason: `${entry.name} (.${ext} not permitted)` };
      }
    }
    return null;
  };
  const res = walk(extractDir);
  if (res && res.error) return res;
  return { ok: true, total_bytes: total };
}

/**
 * Run ClamAV against the extracted dir. `clamscan` is a hard requirement
 * for the import pipeline — we refuse to install user-uploaded content
 * without an active AV scan. Install on Linux via
 * `sudo apt install clamav && sudo freshclam`.
 *
 * Returns { ok, output } on clean, { error, reason } on hit OR missing tool.
 */
async function virusScan(dir) {
  if (!clamScanProbed) {
    try {
      await runShell('sh', ['-c', 'command -v clamscan >/dev/null']);
      clamScanAvailable = true;
    } catch {
      clamScanAvailable = false;
    }
    clamScanProbed = true;
  }
  if (!clamScanAvailable) {
    return {
      error: 'clamscan_missing',
      reason: 'clamscan not found on PATH — install clamav (sudo apt install clamav && sudo freshclam) and retry',
    };
  }
  try {
    const { stdout } = await runShell('clamscan', ['--no-summary', '-r', dir]);
    return { ok: true, output: stdout };
  } catch (err) {
    if (err.exitCode !== 1) {
      // Exit 2+ = clamscan itself crashed (DB missing, permissions, etc).
      return { error: 'clamscan_failed', reason: String(err.message).split('\n')[0].slice(0, 200) };
    }
    // Signature found — search the full stdout for the hit line.
    const text = String(err.stdout || err.message);
    const hit = text.match(/([^\s:]+):\s+(\S+)\s+FOUND/);
    return {
      error: 'virus_detected',
      reason: hit ? `${hit[2]} in ${basename(hit[1])}` : 'clamscan reported a hit',
    };
  }
}

/**
 * Spawn a short-lived Xvfb on the given display, run the thunk, tear down.
 */
async function withSandboxDisplay(fn) {
  const display = `:${SANDBOX_DISPLAY_BASE}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '640x480x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  // Wait for the socket to appear (Xvfb creates /tmp/.X11-unix/X<n>).
  const sock = `/tmp/.X11-unix/X${display.slice(1)}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(sock)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    return await fn(display);
  } finally {
    try { xvfb.kill('SIGTERM'); } catch {}
    try { spawn('pkill', ['-f', `Xvfb ${display} `], { stdio: 'ignore' }); } catch {}
  }
}

/**
 * Test match vs KFM. Returns { ok, log, reason? }. "ok" means Ikemen ran to
 * a normal finish (rounds recorded). Timeout, engine error, or no-rounds
 * = reject.
 */
async function sandboxTest(db, fileName) {
  const stageRow = db.prepare("SELECT file_name FROM stage WHERE active = 1 ORDER BY RANDOM() LIMIT 1").get();
  if (!stageRow) return { ok: false, reason: 'no_active_stages' };
  const logPath = `/tmp/mb-sandbox-${fileName}-${randomUUID().slice(0, 6)}.log`;
  try {
    return await withSandboxDisplay(async (display) => {
      try {
        const result = await runMatch(fileName, 'kfm', stageRow.file_name, {
          logPath, display, speed: 'speedtest',
        });
        const log = safeReadLog(logPath);
        if (!result || (result.fighter1Rounds === 0 && result.fighter2Rounds === 0)) {
          return { ok: false, reason: 'no_rounds_scored', log };
        }
        return { ok: true, log };
      } catch (err) {
        return { ok: false, reason: `match_failed: ${String(err.message).split('\n')[0]}`, log: safeReadLog(logPath) };
      }
    });
  } finally {
    try { unlinkSync(logPath); } catch {}
  }
}

function safeReadLog(path) {
  try {
    const txt = readFileSync(path, 'utf-8');
    return txt.length > SANDBOX_LOG_MAX_CHARS ? txt.slice(-SANDBOX_LOG_MAX_CHARS) : txt;
  } catch {
    return null;
  }
}

function readDefMetadata(charDir, fileName) {
  try {
    const text = readFileSync(join(charDir, `${fileName}.def`), 'utf-8');
    const displayName = text.match(/^\s*displayname\s*=\s*"?([^";\r\n]*)"?/im)?.[1]?.trim();
    const name = text.match(/^\s*name\s*=\s*"?([^";\r\n]*)"?/im)?.[1]?.trim();
    const author = text.match(/^\s*author\s*=\s*"?([^";\r\n]*)"?/im)?.[1]?.trim();
    return {
      displayName: displayName || name || fileName,
      author: author || null,
    };
  } catch {
    return { displayName: fileName, author: null };
  }
}

/**
 * Full import pipeline. The zipPath must exist on disk and be readable by
 * this process. On completion the path is NOT deleted (caller manages).
 * Returns the character_import row's state: { ok, import_id, file_name,
 * fighter_id } or { error, reason, import_id }.
 */
export async function importCharFromZip(db, { zipPath, originalFilename, userId }) {
  if (!existsSync(zipPath)) return { error: 'zip_missing' };
  const stat = statSync(zipPath);
  if (stat.size > MAX_ZIP_BYTES) return { error: 'zip_too_large', max: MAX_ZIP_BYTES, got: stat.size };

  const sha = sha256File(zipPath);

  // Dedup: if a prior approved import had the same hash, reject early.
  const dupe = db.prepare(
    "SELECT id, file_name FROM character_import WHERE sha256 = ? AND status = 'approved' LIMIT 1"
  ).get(sha);
  if (dupe) {
    return { error: 'duplicate_upload', reason: `already imported as ${dupe.file_name}`, fighter_id: null };
  }

  const insertImport = db.prepare(`
    INSERT INTO character_import (user_id, original_filename, size_bytes, sha256, status)
    VALUES (?, ?, ?, ?, 'extracting')
  `);
  const importId = insertImport.run(userId, originalFilename || null, stat.size, sha).lastInsertRowid;

  const fail = (reason, extra = {}) => {
    db.prepare(
      "UPDATE character_import SET status = 'rejected', reject_reason = ?, test_log = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(reason, extra.testLog || null, importId);
    return { error: 'rejected', reason, import_id: importId };
  };

  let extractDir, targetDir;
  try {
    // 1. Extract
    try {
      extractDir = await extractZip(zipPath);
    } catch (err) {
      return fail(`extract_failed: ${err.message.split('\n')[0]}`);
    }

    // 2. Safety scan BEFORE we touch engine/chars/. Denylist extensions +
    //    per-file + total size caps (zip bomb) + optional ClamAV.
    const tree = scanExtractedTree(extractDir);
    if (tree.error) return fail(`${tree.error}: ${tree.reason}`);
    const av = await virusScan(extractDir);
    if (av.error) return fail(`${av.error}: ${av.reason}`);

    // 3. Find char dir + file_name
    const shape = findCharDir(extractDir);
    if (shape.error) return fail(shape.error);
    const { charDir, fileName } = shape;
    if (!isValidFileName(fileName)) return fail(`bad_file_name: ${fileName}`);

    db.prepare('UPDATE character_import SET file_name = ? WHERE id = ?').run(fileName, importId);

    // 4. Name conflict check
    targetDir = join(CHARS_DIR, fileName);
    if (existsSync(targetDir)) return fail('name_conflict', { });
    const existing = db.prepare('SELECT id FROM fighter WHERE file_name = ?').get(fileName);
    if (existing) return fail('name_conflict_in_db');

    // 4. Move into engine/chars/. renameSync fails across filesystems (tmpfs
    // → disk is the common case when /tmp lives on tmpfs), so copy+purge.
    cpSync(charDir, targetDir, { recursive: true });
    try { rmSync(charDir, { recursive: true, force: true }); } catch {}

    // 5. Static validator
    db.prepare("UPDATE character_import SET status = 'validating' WHERE id = ?").run(importId);
    const vres = validateFighter(fileName);
    if (!vres.ok) return fail(`static_validation: ${vres.reason}`);

    // 6. Sandbox test match
    db.prepare("UPDATE character_import SET status = 'testing' WHERE id = ?").run(importId);
    const test = await sandboxTest(db, fileName);
    if (!test.ok) return fail(test.reason, { testLog: test.log });

    // 7. Install: insert fighter row
    const meta = readDefMetadata(targetDir, fileName);
    const inserted = db.prepare(`
      INSERT INTO fighter
        (file_name, display_name, author, is_master, active, is_unique, imported_by_user_id)
      VALUES (?, ?, ?, 1, 1, 1, ?)
    `).run(fileName, meta.displayName, meta.author, userId);
    const fighterId = inserted.lastInsertRowid;

    db.prepare(
      "UPDATE character_import SET status = 'approved', fighter_id = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(fighterId, importId);

    return { ok: true, import_id: importId, file_name: fileName, fighter_id: fighterId };
  } catch (err) {
    // Defensive: unexpected throw. Roll back the install dir if we moved one.
    if (targetDir && existsSync(targetDir)) {
      try { rmSync(targetDir, { recursive: true, force: true }); } catch {}
    }
    return fail(`unexpected: ${String(err.message).split('\n')[0]}`);
  } finally {
    if (extractDir && existsSync(extractDir)) {
      try { rmSync(extractDir, { recursive: true, force: true }); } catch {}
    }
    // If we installed but then failed, ensure the dir is gone.
    const importNow = db.prepare('SELECT status FROM character_import WHERE id = ?').get(importId);
    if (importNow?.status === 'rejected' && targetDir && existsSync(targetDir)) {
      try { rmSync(targetDir, { recursive: true, force: true }); } catch {}
    }
  }
}

export function listUserImports(db, userId, limit = 20) {
  return db.prepare(`
    SELECT id, original_filename, file_name, status, reject_reason, fighter_id,
      size_bytes, created_at, finished_at
    FROM character_import
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(userId, limit);
}
