import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LOG_FILE = join(PROJECT_ROOT, 'matchData.log');
const MAX_RETRIES = 3;

const isWindows = os.platform() === 'win32';

/**
 * Launch a match between two fighters on a stage.
 * Supports both MUGEN (Windows) and Ikemen GO (Linux).
 * Returns the parsed result: { winner: 'fighter1'|'fighter2'|'draw', fighter1Rounds, fighter2Rounds }
 */
export async function runMatch(fighter1, fighter2, stage) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stdout = await launchEngine(fighter1, fighter2, stage);
      if (isWindows) {
        return parseMugenResult(stdout);
      } else {
        const logContents = await readFile(LOG_FILE, 'utf-8');
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

function launchEngine(fighter1, fighter2, stage) {
  return new Promise((resolve, reject) => {
    let cmd, args;

    if (isWindows) {
      const batPath = join(PROJECT_ROOT, 'runMugenTourney.bat');
      cmd = 'cmd.exe';
      args = ['/c', batPath, fighter1, fighter2, stage];
    } else {
      const shPath = join(PROJECT_ROOT, 'runMatch.sh');
      cmd = shPath;
      args = [fighter1, fighter2, stage];
    }

    // Hard timeout: matches should finish in <90s. If Ikemen hangs on a modal
    // error dialog, this kills it and lets the tournament move on.
    const child = execFile(cmd, args, { timeout: 120_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    return child;
  });
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
