/**
 * Per-match character staging.
 *
 * Ikemen resolves -p1 <name> to engine/chars/<name>/<name>.def, so to ship a
 * user-edited AI we need the staged copy to live under engine/chars/ with a
 * unique name.
 *
 * stageOwnedFighter returns:
 *   { charName, stagedDir, cleanup }
 *
 * The caller MUST invoke cleanup() (ideally in a finally) or the staged dir
 * lingers on disk.
 *
 * Concurrency-safe: each call gets its own uuid-prefixed dir, so two leagues
 * running in parallel never collide on the same char.
 */

import { randomUUID } from 'crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { validateFighter } from './validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHARS_DIR = resolve(__dirname, '..', 'engine', 'chars');
const STAGE_PREFIX = 'stg_';

/**
 * Find which file in the char dir is the main .cmd referenced by the .def.
 * Looks at [Files] section's `cmd = ...` line.
 */
function findCmdPath(charDir, charFileName) {
  const defPath = join(charDir, `${charFileName}.def`);
  if (!existsSync(defPath)) {
    // Fall back: any .def in the dir
    const anyDef = readdirSync(charDir).find((f) => f.toLowerCase().endsWith('.def'));
    if (!anyDef) return null;
    return parseCmdFromDef(join(charDir, anyDef), charDir);
  }
  return parseCmdFromDef(defPath, charDir);
}

function parseCmdFromDef(defPath, charDir) {
  const text = readFileSync(defPath, 'utf-8');
  let inFiles = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]/);
    if (sec) { inFiles = /^files$/i.test(sec[1].trim()); continue; }
    if (!inFiles) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    if (kv[1].toLowerCase() === 'cmd') {
      const ref = kv[2].replace(/^"|"$/g, '').trim();
      return join(charDir, ref);
    }
  }
  return null;
}

/**
 * Stage an owned_fighter for a single match. Clones the master char dir under
 * a unique name, then if an AI override exists, overwrites the staged char's
 * .cmd file with the override text.
 *
 * Returns { charName, stagedDir, cleanup }. Pass charName as Ikemen's -p1/-p2.
 */
export function stageOwnedFighter(db, ownedFighterId) {
  const fighter = db.prepare(`
    SELECT of.id AS owned_id,
      f.file_name AS master_file_name
    FROM owned_fighter of
    JOIN fighter f ON of.master_fighter_id = f.id
    WHERE of.id = ?
  `).get(ownedFighterId);
  if (!fighter) throw new Error(`owned_fighter ${ownedFighterId} not found`);

  const masterDir = join(CHARS_DIR, fighter.master_file_name);
  if (!existsSync(masterDir)) {
    throw new Error(`Master char dir missing: ${masterDir}`);
  }

  const uuid = randomUUID().slice(0, 8);
  const charName = `${STAGE_PREFIX}${uuid}_${fighter.master_file_name}`;
  const stagedDir = join(CHARS_DIR, charName);

  // Clone. Use cp -a semantics (preserves everything). cpSync recursive.
  mkdirSync(stagedDir, { recursive: true });
  cpSync(masterDir, stagedDir, { recursive: true });

  // If the staged dir has <masterName>.def, rename that to <charName>.def so
  // Ikemen's -p1 resolution finds it. Keep the original too as a fallback.
  const masterDefInStaged = join(stagedDir, `${fighter.master_file_name}.def`);
  const wantedDef = join(stagedDir, `${charName}.def`);
  if (existsSync(masterDefInStaged) && !existsSync(wantedDef)) {
    writeFileSync(wantedDef, readFileSync(masterDefInStaged));
  }

  // Apply AI override if any
  const override = db.prepare(
    'SELECT cmd_text FROM owned_fighter_ai WHERE owned_fighter_id = ? ORDER BY version DESC LIMIT 1'
  ).get(ownedFighterId);
  if (override) {
    const cmdPath = findCmdPath(stagedDir, fighter.master_file_name)
                 || findCmdPath(stagedDir, charName);
    if (cmdPath && existsSync(cmdPath)) {
      writeFileSync(cmdPath, override.cmd_text);
    }
  }

  const cleanup = () => {
    try { rmSync(stagedDir, { recursive: true, force: true }); } catch {}
  };

  return { charName, stagedDir, cleanup };
}

/**
 * Return the cmd_text that the user would be editing: the latest override if
 * one exists, otherwise the master's stock .cmd content.
 */
export function getEffectiveCmd(db, ownedFighterId) {
  const override = db.prepare(
    'SELECT cmd_text, version FROM owned_fighter_ai WHERE owned_fighter_id = ? ORDER BY version DESC LIMIT 1'
  ).get(ownedFighterId);
  if (override) return { source: 'override', version: override.version, cmd_text: override.cmd_text };

  const fighter = db.prepare(`
    SELECT f.file_name FROM owned_fighter of JOIN fighter f ON of.master_fighter_id = f.id WHERE of.id = ?
  `).get(ownedFighterId);
  if (!fighter) return null;
  const masterDir = join(CHARS_DIR, fighter.file_name);
  const cmdPath = findCmdPath(masterDir, fighter.file_name);
  if (!cmdPath || !existsSync(cmdPath)) return null;
  return { source: 'master', version: 0, cmd_text: readFileSync(cmdPath, 'utf-8') };
}

/**
 * Write a new AI override for an owned_fighter. Validates the new cmd via
 * the existing validator pipeline by briefly staging the char, then rolls
 * that staging back. Returns { ok, version } or { error, reason }.
 */
export function saveCmdOverride(db, ownedFighterId, cmdText) {
  if (typeof cmdText !== 'string' || cmdText.length < 20 || cmdText.length > 200_000) {
    return { error: 'cmd_text must be a plausible .cmd file (20–200000 chars)' };
  }

  // Validate by staging a short-lived clone with the proposed cmd, running
  // validator, then cleaning up. Reuses existing src/validator.js logic
  // which reads a char from engine/chars/<name>/.
  const probe = stageCharWithCmd(db, ownedFighterId, cmdText);
  try {
    const res = validateFighter(probe.charName);
    if (!res.ok) {
      return { error: 'Proposed AI failed validation', reason: res.reason };
    }
  } finally {
    probe.cleanup();
  }

  // Insert new version
  const nextVersion = (db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM owned_fighter_ai WHERE owned_fighter_id = ?'
  ).get(ownedFighterId).v || 0) + 1;
  db.prepare(
    'INSERT INTO owned_fighter_ai (owned_fighter_id, cmd_text, version) VALUES (?, ?, ?)'
  ).run(ownedFighterId, cmdText, nextVersion);
  return { ok: true, version: nextVersion };
}

function stageCharWithCmd(db, ownedFighterId, cmdText) {
  const fighter = db.prepare(`
    SELECT f.file_name FROM owned_fighter of JOIN fighter f ON of.master_fighter_id = f.id WHERE of.id = ?
  `).get(ownedFighterId);
  if (!fighter) throw new Error(`owned_fighter ${ownedFighterId} not found`);
  const masterDir = join(CHARS_DIR, fighter.file_name);
  const uuid = randomUUID().slice(0, 8);
  const charName = `${STAGE_PREFIX}probe_${uuid}_${fighter.file_name}`;
  const stagedDir = join(CHARS_DIR, charName);
  mkdirSync(stagedDir, { recursive: true });
  cpSync(masterDir, stagedDir, { recursive: true });
  const masterDefInStaged = join(stagedDir, `${fighter.file_name}.def`);
  const wantedDef = join(stagedDir, `${charName}.def`);
  if (existsSync(masterDefInStaged) && !existsSync(wantedDef)) {
    writeFileSync(wantedDef, readFileSync(masterDefInStaged));
  }
  const cmdPath = findCmdPath(stagedDir, fighter.file_name);
  if (cmdPath) writeFileSync(cmdPath, cmdText);
  return {
    charName,
    cleanup: () => { try { rmSync(stagedDir, { recursive: true, force: true }); } catch {} },
  };
}
