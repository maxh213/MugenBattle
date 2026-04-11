import { execFile } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BAT_PATH = resolve(__dirname, '..', 'runMugenTourney.bat');
const MAX_RETRIES = 3;

/**
 * Launch a MUGEN match between two fighters on a stage.
 * Returns the parsed result: { winner: 'fighter1'|'fighter2'|'draw', fighter1Rounds, fighter2Rounds }
 */
export async function runMatch(fighter1, fighter2, stage) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stdout = await launchMugen(fighter1, fighter2, stage);
      return parseResult(stdout, fighter1, fighter2);
    } catch (err) {
      lastError = err;
      console.log(`Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
    }
  }

  throw new Error(`Match failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
}

function launchMugen(fighter1, fighter2, stage) {
  return new Promise((resolve, reject) => {
    execFile('cmd.exe', ['/c', BAT_PATH, fighter1, fighter2, stage], (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Parse MUGEN log output for round winners.
 * Only counts lines that match "winningteam = N" exactly,
 * fixing the original bug where all 1s/2s in stdout were counted.
 */
export function parseResult(stdout, fighter1, fighter2) {
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
