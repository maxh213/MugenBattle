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
        // MUGEN outputs "winningteam = N" lines to stdout via the batch file
        return parseMugenResult(stdout);
      } else {
        // Ikemen GO writes stats to a log file via -log flag
        const logContents = await readFile(LOG_FILE, 'utf-8');
        return parseIkemenResult(logContents);
      }
    } catch (err) {
      lastError = err;
      console.log(`Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
    }
  }

  throw new Error(`Match failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
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

    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
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
 * The log uses f_printTable format. Key fields:
 *   ["WinSide"] => 0      (0 = P1 wins, 1 = P2 wins, -1 = draw)
 *   ["Wins"] => table {
 *     [1] => 2             (P1 round wins)
 *     [2] => 1             (P2 round wins)
 *   }
 * Note: WinSide is zero-indexed unlike MUGEN's 1-indexed winningteam.
 */
export function parseIkemenResult(logContents) {
  let fighter1Rounds = 0;
  let fighter2Rounds = 0;

  // Try the Wins table first for round-level detail
  const winsMatch = logContents.match(/\["Wins"\]\s*=>\s*table[^{]*\{([^}]+)\}/);
  if (winsMatch) {
    const winsBlock = winsMatch[1];
    const p1Wins = winsBlock.match(/\[1\]\s*=>\s*(\d+)/);
    const p2Wins = winsBlock.match(/\[2\]\s*=>\s*(\d+)/);
    if (p1Wins) fighter1Rounds = parseInt(p1Wins[1], 10);
    if (p2Wins) fighter2Rounds = parseInt(p2Wins[1], 10);
  }

  // If Wins table wasn't found or was all zeros, fall back to WinSide
  if (fighter1Rounds === 0 && fighter2Rounds === 0) {
    const winSideMatch = logContents.match(/\["WinSide"\]\s*=>\s*(-?\d+)/);
    if (winSideMatch) {
      const side = parseInt(winSideMatch[1], 10);
      // WinSide: 0 = P1, 1 = P2, -1 = draw
      if (side === 0) fighter1Rounds = 1;
      else if (side === 1) fighter2Rounds = 1;
      // side === -1 means draw, both stay 0
    }
  }

  // Last resort: check for classic MUGEN-style "winningteam" lines
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
