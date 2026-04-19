import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { stageOwnedFighter } from './matchStaging.js';
import {
  readEffectiveStamina,
  staminaToLife,
  applyMatchCost,
} from './stamina.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DEFAULT_LOG_FILE = join(PROJECT_ROOT, 'matchData.log');
const MAX_RETRIES = 3;

const isWindows = os.platform() === 'win32';

/**
 * Fake-match mode (MB_MATCH_MODE=fake) short-circuits Ikemen launches with
 * a deterministic stamina+wins+seed formula. Only used in tests. MB_MATCH_SEED
 * controls the RNG so results are repeatable.
 */
const FAKE_MODE = process.env.MB_MATCH_MODE === 'fake';
let fakeRngState = Number(process.env.MB_MATCH_SEED || '1');
function fakeRng() {
  // mulberry32
  fakeRngState = (fakeRngState + 0x6D2B79F5) | 0;
  let t = fakeRngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function fakeDecide(home, away, homeStam, awayStam) {
  // Strength ≈ stamina (0..1) + master wins bonus (0..1, saturates at 100 wins).
  const hStrength = homeStam + Math.min(1, (home.masterWins || 0) / 100);
  const aStrength = awayStam + Math.min(1, (away.masterWins || 0) / 100);
  const spread = (hStrength - aStrength) + (fakeRng() - 0.5) * 0.6;
  if (spread > 0.1) return { winner: 'fighter1', fighter1Rounds: 1, fighter2Rounds: 0 };
  if (spread < -0.1) return { winner: 'fighter2', fighter1Rounds: 0, fighter2Rounds: 1 };
  return { winner: 'draw', fighter1Rounds: 0, fighter2Rounds: 0 };
}

/**
 * Per-worker context for multi-stream league runners:
 *   logPath — unique log file so parallel matches don't stomp each other.
 *   display — X DISPLAY env value (e.g. ":100" for worker 1's Xvfb).
 * Both optional; when omitted we fall back to the historical single-writer
 * defaults — safe for CLI one-shots and the existing tournament flow.
 */
function resolveCtx(ctx = {}) {
  return {
    logPath: ctx.logPath || DEFAULT_LOG_FILE,
    display: ctx.display || process.env.DISPLAY || null,
    speed: ctx.speed || process.env.MATCH_SPEED || null,
  };
}

/**
 * Launch a match between two fighters on a stage.
 * Supports both MUGEN (Windows) and Ikemen GO (Linux).
 * Returns the parsed result: { winner: 'fighter1'|'fighter2'|'draw', fighter1Rounds, fighter2Rounds }
 */
export async function runMatch(fighter1, fighter2, stage, ctx) {
  const { logPath } = resolveCtx(ctx);
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stdout = await launchEngine(fighter1, fighter2, stage, null, null, ctx);
      if (isWindows) {
        return parseMugenResult(stdout);
      } else {
        const logContents = await readFile(logPath, 'utf-8');
        return parseIkemenResult(logContents);
      }
    } catch (err) {
      lastError = err;
      // Don't retry on deterministic engine errors (missing files, broken defs, etc.)
      // — retrying just pops the same modal again.
      if (isDeterministicFailure(err)) {
        throw new Error(`Match failed (deterministic): ${err.message}`);
      }
      console.log(`Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
    }
  }

  throw new Error(`Match failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
}

function isDeterministicFailure(err) {
  const msg = String(err?.message || err);
  return (
    msg.includes('no such file or directory') ||
    msg.includes('panic:') ||
    msg.includes('error loading') ||
    msg.includes('chars/') ||
    msg.includes('stages/')
  );
}

function launchEngine(fighter1, fighter2, stage, p1Life, p2Life, ctx) {
  const { logPath, display, speed } = resolveCtx(ctx);
  return new Promise((resolve, reject) => {
    let cmd, args;

    if (isWindows) {
      const batPath = join(PROJECT_ROOT, 'runMugenTourney.bat');
      cmd = 'cmd.exe';
      args = ['/c', batPath, fighter1, fighter2, stage];
      // Windows batch path doesn't wire life args yet — v1 owned matches are Linux-only.
    } else {
      const shPath = join(PROJECT_ROOT, 'runMatch.sh');
      cmd = shPath;
      args = [fighter1, fighter2, stage];
      if (p1Life != null) args.push(String(p1Life));
      if (p2Life != null) args.push(String(p2Life));
    }

    const env = { ...process.env, MATCH_LOG_FILE: logPath };
    if (display) env.DISPLAY = display;
    if (speed) env.MATCH_SPEED = String(speed);

    // Patterns that mean "this char just broke Ikemen, won't recover":
    //   - Go runtime panics (stderr)
    //   - Ikemen Lua error modal (written to the log file, process stays alive)
    //   - Any "I.K.E.M.E.N Error" banner
    // On any of these, SIGKILL within ~1s so the stream doesn't show the
    // modal for the full 120s exec timeout.
    const ERROR_RX = /panic:|runtime error:|fatal error:|I\.K\.E\.M\.E\.N Error/;

    const child = execFile(cmd, args, {
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env,
    }, (error, stdout, stderr) => {
      clearInterval(logPoller);
      if (error) {
        // Attach the log contents so callers can regex for the offending
        // char's dir. Ikemen's Lua modal error gets logged but NOT written
        // to stderr, so err.message alone wouldn't identify the char.
        try { error.matchLog = readFileSync(logPath, 'utf-8'); } catch { error.matchLog = ''; }
        if (error.matchLog) error.message = `${error.message}\n${error.matchLog.slice(-2000)}`;
        reject(error);
      } else {
        resolve(stdout);
      }
    });

    // Watch stderr for Go panics (written immediately on crash).
    let stderrBuf = '';
    child.stderr?.on('data', (chunk) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 200_000) stderrBuf = stderrBuf.slice(-100_000);
      if (ERROR_RX.test(stderrBuf)) {
        try { child.kill('SIGKILL'); } catch {}
      }
    });

    // Poll the match log — catches Ikemen's Lua modal errors that hang the
    // process waiting for an OK click.
    const logPoller = setInterval(() => {
      try {
        const content = readFileSync(logPath, 'utf-8');
        if (ERROR_RX.test(content)) {
          clearInterval(logPoller);
          try { child.kill('SIGKILL'); } catch {}
        }
      } catch {}
    }, 1000);

    return child;
  });
}

/**
 * Run a match between two owned_fighter rows. Stages both chars (so AI
 * overrides apply), scales life by effective stamina, updates per-fighter
 * stats + stamina after the match, and cleans up the staged dirs.
 *
 * Returns the parsed result + the life/stamina metadata used, so callers
 * (tests, league runner) can log/assert.
 */
export async function runOwnedFighterMatch({
  db,
  homeOwnedFighterId,
  awayOwnedFighterId,
  stageFileName,
  ctx,
}) {
  const home = db.prepare('SELECT * FROM owned_fighter WHERE id = ?').get(homeOwnedFighterId);
  const away = db.prepare('SELECT * FROM owned_fighter WHERE id = ?').get(awayOwnedFighterId);
  if (!home || !away) throw new Error('owned_fighter not found');

  const homeStam = readEffectiveStamina(db, homeOwnedFighterId);
  const awayStam = readEffectiveStamina(db, awayOwnedFighterId);
  const homeLife = staminaToLife(homeStam);
  const awayLife = staminaToLife(awayStam);

  let result;
  if (FAKE_MODE) {
    // Deterministic stand-in — no Ikemen spawn, no staging, no log parse.
    const hm = db.prepare('SELECT matches_won FROM fighter WHERE id = ?').get(home.master_fighter_id);
    const am = db.prepare('SELECT matches_won FROM fighter WHERE id = ?').get(away.master_fighter_id);
    result = fakeDecide(
      { masterWins: hm?.matches_won || 0 },
      { masterWins: am?.matches_won || 0 },
      homeStam, awayStam,
    );
  } else {
    const homeStage = stageOwnedFighter(db, homeOwnedFighterId);
    const awayStage = stageOwnedFighter(db, awayOwnedFighterId);
    const { logPath } = resolveCtx(ctx);
    try {
      await launchEngine(homeStage.charName, awayStage.charName, stageFileName, homeLife, awayLife, ctx);
      const logContents = await readFile(logPath, 'utf-8');
      result = parseIkemenResult(logContents);
    } finally {
      homeStage.cleanup();
      awayStage.cleanup();
    }
  }

  // Persist stats + stamina in a single transaction. Master-level counters
  // are also bumped so market pricing reflects lifetime record across all
  // past owners of that master.
  const bumpOwnedW = db.prepare('UPDATE owned_fighter SET matches_won = matches_won + 1 WHERE id = ?');
  const bumpOwnedL = db.prepare('UPDATE owned_fighter SET matches_lost = matches_lost + 1 WHERE id = ?');
  const bumpOwnedD = db.prepare('UPDATE owned_fighter SET matches_drawn = matches_drawn + 1 WHERE id = ?');
  const bumpMasterW = db.prepare('UPDATE fighter SET matches_won = matches_won + 1 WHERE id = ?');
  const bumpMasterL = db.prepare('UPDATE fighter SET matches_lost = matches_lost + 1 WHERE id = ?');
  const bumpMasterD = db.prepare('UPDATE fighter SET matches_drawn = matches_drawn + 1 WHERE id = ?');

  const tx = db.transaction(() => {
    if (result.winner === 'fighter1') {
      bumpOwnedW.run(homeOwnedFighterId); bumpMasterW.run(home.master_fighter_id);
      bumpOwnedL.run(awayOwnedFighterId); bumpMasterL.run(away.master_fighter_id);
    } else if (result.winner === 'fighter2') {
      bumpOwnedW.run(awayOwnedFighterId); bumpMasterW.run(away.master_fighter_id);
      bumpOwnedL.run(homeOwnedFighterId); bumpMasterL.run(home.master_fighter_id);
    } else {
      bumpOwnedD.run(homeOwnedFighterId); bumpMasterD.run(home.master_fighter_id);
      bumpOwnedD.run(awayOwnedFighterId); bumpMasterD.run(away.master_fighter_id);
    }
    applyMatchCost(db, homeOwnedFighterId);
    applyMatchCost(db, awayOwnedFighterId);
  });
  tx();

  return {
    ...result,
    home: { id: home.id, name: home.display_name },
    away: { id: away.id, name: away.display_name },
    homeLife,
    awayLife,
    homeStam,
    awayStam,
  };
}

/**
 * Parse classic MUGEN stdout for round winners.
 * Looks for "winningteam = N" lines.
 */
export function parseMugenResult(stdout) {
  const lines = stdout.split('\n');
  let fighter1Rounds = 0;
  let fighter2Rounds = 0;

  for (const line of lines) {
    const match = line.match(/^winningteam\s*=\s*(\d+)/);
    if (match) {
      const team = parseInt(match[1], 10);
      if (team === 1) fighter1Rounds++;
      else if (team === 2) fighter2Rounds++;
    }
  }

  return toResult(fighter1Rounds, fighter2Rounds);
}

/**
 * Parse Ikemen GO log file output.
 * v0.99.0+ emits an f_printTable dump with flat summary keys:
 *   [p1wins] => 2     (P1 round wins)
 *   [p2wins] => 1     (P2 round wins)
 *   [draws]  => 0
 *   [winTeam] => 0    (0 = P1, 1 = P2)
 * Older releases used ["WinSide"] / ["Wins"] table form — still handled as fallback.
 */
export function parseIkemenResult(logContents) {
  let fighter1Rounds = 0;
  let fighter2Rounds = 0;

  const p1wins = logContents.match(/\[p1wins\]\s*=>\s*(\d+)/);
  const p2wins = logContents.match(/\[p2wins\]\s*=>\s*(\d+)/);
  if (p1wins) fighter1Rounds = parseInt(p1wins[1], 10);
  if (p2wins) fighter2Rounds = parseInt(p2wins[1], 10);

  if (fighter1Rounds === 0 && fighter2Rounds === 0) {
    const draws = logContents.match(/\[draws\]\s*=>\s*(\d+)/);
    const winTeam = logContents.match(/\[winTeam\]\s*=>\s*(-?\d+)/);
    if (winTeam && (!draws || parseInt(draws[1], 10) === 0)) {
      const team = parseInt(winTeam[1], 10);
      if (team === 0) fighter1Rounds = 1;
      else if (team === 1) fighter2Rounds = 1;
    }
  }

  if (fighter1Rounds === 0 && fighter2Rounds === 0) {
    const winsMatch = logContents.match(/\["Wins"\]\s*=>\s*table[^{]*\{([^}]+)\}/);
    if (winsMatch) {
      const winsBlock = winsMatch[1];
      const p1 = winsBlock.match(/\[1\]\s*=>\s*(\d+)/);
      const p2 = winsBlock.match(/\[2\]\s*=>\s*(\d+)/);
      if (p1) fighter1Rounds = parseInt(p1[1], 10);
      if (p2) fighter2Rounds = parseInt(p2[1], 10);
    }
  }

  if (fighter1Rounds === 0 && fighter2Rounds === 0) {
    const winSideMatch = logContents.match(/\["WinSide"\]\s*=>\s*(-?\d+)/);
    if (winSideMatch) {
      const side = parseInt(winSideMatch[1], 10);
      if (side === 0) fighter1Rounds = 1;
      else if (side === 1) fighter2Rounds = 1;
    }
  }

  if (fighter1Rounds === 0 && fighter2Rounds === 0) {
    return parseMugenResult(logContents);
  }

  return toResult(fighter1Rounds, fighter2Rounds);
}

function toResult(fighter1Rounds, fighter2Rounds) {
  let winner;
  if (fighter1Rounds > fighter2Rounds) {
    winner = 'fighter1';
  } else if (fighter2Rounds > fighter1Rounds) {
    winner = 'fighter2';
  } else {
    winner = 'draw';
  }
  return { winner, fighter1Rounds, fighter2Rounds };
}
