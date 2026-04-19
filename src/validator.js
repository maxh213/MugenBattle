/**
 * Pre-flight char validation. Catches the common broken-char cases before
 * we launch Ikemen and eat a modal:
 *   - <name>.def exists
 *   - Core files referenced in [Files] exist (cmd, cns, sprite, sound, anim, optional)
 *   - .cmd file doesn't contain the specific VarSet bug (empty value= )
 *
 * Doesn't catch everything — e.g. Lua runtime errors can still happen — but
 * filters the obvious missing-file + malformed-cmd cases that account for most
 * crashes we've seen.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHARS_DIR = resolve(__dirname, '..', 'engine', 'chars');

const FILES_SECTION_KEYS = ['cmd', 'cns', 'st', 'stcommon', 'sprite', 'anim', 'sound', 'movelist'];

function parseDefFiles(defText) {
  // Extract [Files] section (case-insensitive) and return key->value map
  const lines = defText.split(/\r?\n/);
  let inFiles = false;
  const files = {};
  for (const raw of lines) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      inFiles = /^files$/i.test(sectionMatch[1].trim());
      continue;
    }
    if (!inFiles) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].replace(/^"|"$/g, '').trim();
    if (val) files[key] = val;
  }
  return files;
}

function fileExistsInCharDir(charDir, relPath) {
  if (!relPath) return true;
  const full = join(charDir, relPath);
  if (existsSync(full)) return true;
  // MUGEN chars often reference files case-insensitively; try a case-insensitive lookup
  try {
    const dir = dirname(full);
    const base = relPath.split('/').pop().toLowerCase();
    const { readdirSync } = require('fs');
    return readdirSync(dir).some((f) => f.toLowerCase() === base);
  } catch {
    return false;
  }
}

function hasMalformedVarSet(cmdText) {
  // The specific Butthead-style error: VarSet with an empty value field.
  // Ikemen errors with "Invalid value: VarSet" on `value =` or `v = ` with nothing after.
  const lines = cmdText.split(/\r?\n/);
  let inStateDef = false;
  for (const raw of lines) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    if (/^\[/.test(line)) {
      inStateDef = /varset/i.test(line);
      continue;
    }
    if (!inStateDef) continue;
    // value = ... or v = ...
    if (/^(value|v)\s*=\s*$/i.test(line)) return true;
  }
  return false;
}

/**
 * Validate a single fighter. Returns { ok, reason }.
 */
export function validateFighter(fileName) {
  const charDir = join(CHARS_DIR, fileName);
  const defPath = join(charDir, `${fileName}.def`);
  if (!existsSync(defPath)) return { ok: false, reason: 'def_missing' };

  let defText;
  try {
    defText = readFileSync(defPath, 'utf-8');
  } catch {
    return { ok: false, reason: 'def_unreadable' };
  }

  const files = parseDefFiles(defText);
  // Minimum must have cmd, cns, sprite. Optional: snd, air, st, stcommon.
  const mustHave = ['cmd', 'cns', 'sprite'];
  for (const key of mustHave) {
    const ref = files[key];
    if (!ref) return { ok: false, reason: `missing_${key}_ref` };
    if (!fileExistsInCharDir(charDir, ref)) return { ok: false, reason: `${key}_file_missing:${ref}` };
  }
  // Best-effort checks for commonly-referenced optional files:
  for (const key of ['anim', 'sound', 'st']) {
    const ref = files[key];
    if (ref && !fileExistsInCharDir(charDir, ref)) {
      return { ok: false, reason: `${key}_file_missing:${ref}` };
    }
  }

  // Check the CMD file for the malformed-VarSet pattern
  const cmdRef = files.cmd;
  try {
    const cmdText = readFileSync(join(charDir, cmdRef), 'utf-8');
    if (hasMalformedVarSet(cmdText)) return { ok: false, reason: 'malformed_varset' };
    if (cmdText.length < 100) return { ok: false, reason: 'cmd_too_small' };
  } catch {
    // already covered by file_missing check above
  }

  return { ok: true };
}

/**
 * Validate each active fighter and deactivate failures.
 * Uses DB's `validated_at` column to skip already-checked chars.
 */
export function validateAllActive(db, { force = false } = {}) {
  const rows = db
    .prepare(
      force
        ? 'SELECT id, file_name FROM fighter WHERE active = 1'
        : 'SELECT id, file_name FROM fighter WHERE active = 1 AND validated_at IS NULL'
    )
    .all();

  const update = db.prepare(
    'UPDATE fighter SET active = ?, validated_at = datetime(\'now\'), validation_reason = ? WHERE id = ?'
  );
  let ok = 0;
  let bad = 0;
  const reasons = {};

  for (const row of rows) {
    const res = validateFighter(row.file_name);
    if (res.ok) {
      update.run(1, null, row.id);
      ok++;
    } else {
      update.run(0, res.reason, row.id);
      bad++;
      reasons[res.reason.split(':')[0]] = (reasons[res.reason.split(':')[0]] || 0) + 1;
    }
  }
  return { ok, bad, reasons, total: rows.length };
}
