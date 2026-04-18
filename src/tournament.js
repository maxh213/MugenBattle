import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { runMatch } from './match.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHARS_DIR = resolve(__dirname, '..', 'engine', 'chars');
const STAGES_DIR = resolve(__dirname, '..', 'engine', 'stages');

export function addFighter(fileName, { displayName, author, sourceUrl } = {}) {
  const db = getDb();
  const meta = readCharDefMetadata(fileName);
  db.prepare(
    'INSERT INTO fighter (file_name, display_name, author, source_url) VALUES (?, ?, ?, ?)'
  ).run(
    fileName,
    displayName || meta.displayName || fileName,
    author ?? meta.author ?? null,
    sourceUrl ?? null
  );
}

export function addStage(fileName, { displayName, author, sourceUrl } = {}) {
  const db = getDb();
  const meta = readStageDefMetadata(fileName);
  db.prepare(
    'INSERT INTO stage (file_name, display_name, author, source_url) VALUES (?, ?, ?, ?)'
  ).run(
    fileName,
    displayName || meta.displayName || fileName,
    author ?? meta.author ?? null,
    sourceUrl ?? null
  );
}

function parseInfoSection(text) {
  const out = {};
  const keys = ['name', 'displayname', 'author'];
  for (const key of keys) {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*"?([^";\\r\\n]*)"?`, 'im');
    const m = text.match(re);
    if (m) out[key] = m[1].trim();
  }
  return { displayName: out.displayname || out.name, author: out.author };
}

function readCharDefMetadata(fileName) {
  try {
    const defPath = join(CHARS_DIR, fileName, `${fileName}.def`);
    const text = readFileSync(defPath, 'utf-8');
    return parseInfoSection(text);
  } catch {
    return {};
  }
}

function readStageDefMetadata(fileName) {
  try {
    const defPath = join(STAGES_DIR, `${fileName}.def`);
    const text = readFileSync(defPath, 'utf-8');
    return parseInfoSection(text);
  } catch {
    return {};
  }
}

export function backfillAuthors() {
  const db = getDb();
  const update = db.prepare(
    'UPDATE fighter SET author = COALESCE(author, ?), display_name = COALESCE(display_name, ?) WHERE file_name = ?'
  );
  const rows = db.prepare('SELECT file_name FROM fighter').all();
  let updated = 0;
  for (const { file_name } of rows) {
    const meta = readCharDefMetadata(file_name);
    if (meta.author || meta.displayName) {
      update.run(meta.author ?? null, meta.displayName ?? null, file_name);
      updated++;
    }
  }
  const stageUpdate = db.prepare(
    'UPDATE stage SET author = COALESCE(author, ?), display_name = COALESCE(display_name, ?) WHERE file_name = ?'
  );
  const stages = db.prepare('SELECT file_name FROM stage').all();
  for (const { file_name } of stages) {
    const meta = readStageDefMetadata(file_name);
    if (meta.author || meta.displayName) {
      stageUpdate.run(meta.author ?? null, meta.displayName ?? null, file_name);
      updated++;
    }
  }
  return updated;
}

export function listFighters() {
  const db = getDb();
  return db.prepare('SELECT * FROM fighter ORDER BY file_name').all();
}

export function listStages() {
  const db = getDb();
  return db.prepare('SELECT * FROM stage ORDER BY file_name').all();
}

export function removeFighter(fileName) {
  const db = getDb();
  const result = db.prepare('DELETE FROM fighter WHERE file_name = ?').run(fileName);
  return result.changes > 0;
}

export function removeStage(fileName) {
  const db = getDb();
  const result = db.prepare('DELETE FROM stage WHERE file_name = ?').run(fileName);
  return result.changes > 0;
}

export function getStats() {
  const db = getDb();
  return db
    .prepare(
      `SELECT file_name, display_name, matches_won, matches_lost, matches_drawn,
              (matches_won + matches_lost + matches_drawn) AS total_matches,
              CASE WHEN (matches_won + matches_lost + matches_drawn) > 0
                THEN ROUND(100.0 * matches_won / (matches_won + matches_lost + matches_drawn), 1)
                ELSE 0 END AS win_rate
       FROM fighter
       WHERE active = 1
       ORDER BY matches_won DESC, win_rate DESC`
    )
    .all();
}

export function getHistory(limit = 20) {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         f1.file_name AS fighter1,
         f2.file_name AS fighter2,
         s.file_name AS stage,
         v.file_name AS victor,
         fh.fought_at
       FROM fight_history fh
       JOIN fighter f1 ON fh.fighter_one_id = f1.id
       JOIN fighter f2 ON fh.fighter_two_id = f2.id
       JOIN stage s ON fh.stage_id = s.id
       LEFT JOIN fighter v ON fh.victor_id = v.id
       ORDER BY fh.fought_at DESC
       LIMIT ?`
    )
    .all(limit);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickTwoFighters(fighters) {
  const f1 = pickRandom(fighters);
  // Filter out fighter1 to prevent self-matches
  const remaining = fighters.filter((f) => f.id !== f1.id);
  if (remaining.length === 0) {
    throw new Error('Need at least 2 active fighters to run a match');
  }
  const f2 = pickRandom(remaining);
  return [f1, f2];
}

export async function runSingleMatch() {
  const db = getDb();
  const fighters = db.prepare("SELECT * FROM fighter WHERE active = 1").all();
  const stages = db.prepare("SELECT * FROM stage WHERE active = 1").all();

  if (fighters.length < 2) {
    throw new Error('Need at least 2 active fighters. Add more with: mugenbattle fighters add <name>');
  }
  if (stages.length === 0) {
    throw new Error('Need at least 1 active stage. Add one with: mugenbattle stages add <name>');
  }

  const [f1, f2] = pickTwoFighters(fighters);
  const stage = pickRandom(stages);

  console.log(`\n${f1.file_name} VS ${f2.file_name} on ${stage.file_name}!`);

  const result = await runMatch(f1.file_name, f2.file_name, stage.file_name);

  recordResult(db, f1, f2, stage, result);

  if (result.winner === 'fighter1') {
    console.log(`Winner: ${f1.file_name}! (${result.fighter1Rounds}-${result.fighter2Rounds})`);
  } else if (result.winner === 'fighter2') {
    console.log(`Winner: ${f2.file_name}! (${result.fighter2Rounds}-${result.fighter1Rounds})`);
  } else {
    console.log(`Draw! (${result.fighter1Rounds}-${result.fighter2Rounds})`);
  }

  return { f1, f2, stage, result };
}

function recordResult(db, f1, f2, stage, result) {
  const updateWinner = db.prepare('UPDATE fighter SET matches_won = matches_won + 1 WHERE id = ?');
  const updateLoser = db.prepare('UPDATE fighter SET matches_lost = matches_lost + 1 WHERE id = ?');
  const updateDraw = db.prepare('UPDATE fighter SET matches_drawn = matches_drawn + 1 WHERE id = ?');
  const updateStage = db.prepare('UPDATE stage SET times_used = times_used + 1 WHERE id = ?');
  const insertHistory = db.prepare(
    'INSERT INTO fight_history (fighter_one_id, fighter_two_id, stage_id, victor_id) VALUES (?, ?, ?, ?)'
  );

  const record = db.transaction(() => {
    if (result.winner === 'fighter1') {
      updateWinner.run(f1.id);
      updateLoser.run(f2.id);
      insertHistory.run(f1.id, f2.id, stage.id, f1.id);
    } else if (result.winner === 'fighter2') {
      updateWinner.run(f2.id);
      updateLoser.run(f1.id);
      insertHistory.run(f1.id, f2.id, stage.id, f2.id);
    } else {
      updateDraw.run(f1.id);
      updateDraw.run(f2.id);
      insertHistory.run(f1.id, f2.id, stage.id, null);
    }
    updateStage.run(stage.id);
  });

  record();
}
