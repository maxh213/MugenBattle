import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { getDb } from './db.js';
import { runMatch } from './match.js';
import { validateFighter } from './validator.js';

const STATE_FILE = '/tmp/mugenbattle-match-state.json';

function publishMatchState(state) {
  try {
    if (state) writeFileSync(STATE_FILE, JSON.stringify(state));
    else if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  } catch {}
}

function assertPowerOfTwo(n) {
  if (n < 2 || (n & (n - 1)) !== 0) {
    throw new Error(`Tournament size must be a power of 2 >= 2 (got ${n})`);
  }
}

const NAME_ADJECTIVES = [
  'Eternal', 'Crimson', 'Iron', 'Blood', 'Phantom', 'Infernal', 'Royal', 'Fatal',
  'Absolute', 'Brutal', 'Savage', 'Violent', 'Frozen', 'Burning', 'Cursed', 'Divine',
  'Chaotic', 'Primal', 'Ancient', 'Mythic', 'Steel', 'Shadow', 'Thunder', 'Cosmic',
  'Forbidden', 'Final', 'Twilight', 'Astral', 'Doomed', 'Endless', 'Vengeful', 'Sacred',
  'Hellfire', 'Galactic', 'Tempest', 'Obsidian', 'Wraith', 'Spectral', 'Apocalyptic', 'Volcanic',
];
const NAME_NOUNS = [
  'Gauntlet', 'Carnage', 'Reckoning', 'Onslaught', 'Inferno', 'Tempest', 'Genesis', 'Crucible',
  'Colosseum', 'Tournament', 'Championship', 'Cup', 'Battle', 'Showdown', 'Brawl', 'Kombat',
  'Fury', 'Rampage', 'Judgment', 'Conquest', 'Massacre', 'Strike', 'Onslaught', 'Vortex',
  'Maelstrom', 'Bloodbath', 'Gladiator', 'Skirmish', 'Throwdown', 'Mayhem', 'Pandemonium',
  'Apocalypse', 'Cataclysm', 'Eruption', 'Awakening', 'Ascension', 'Gambit', 'Annihilation',
];

function generateTournamentName() {
  const adj = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
  const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
  return `${adj} ${noun}`;
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function selectFighters(db, size, selection) {
  const active = db
    .prepare('SELECT * FROM fighter WHERE active = 1')
    .all();
  if (active.length < size) {
    throw new Error(`Need at least ${size} active fighters; only ${active.length} available`);
  }

  if (selection === 'top') {
    const ordered = db
      .prepare(`
        SELECT *,
          CASE WHEN (matches_won + matches_lost + matches_drawn) > 0
            THEN 100.0 * matches_won / (matches_won + matches_lost + matches_drawn)
            ELSE 0 END AS win_rate,
          (matches_won + matches_lost + matches_drawn) AS total_matches
        FROM fighter WHERE active = 1
        ORDER BY win_rate DESC, matches_won DESC, total_matches DESC
      `)
      .all();
    return ordered.slice(0, size);
  }

  if (selection === 'fresh') {
    // Pick the fighters with the least total matches, tiebreak random.
    // Ensures everyone eventually plays without getting trapped on popular chars.
    const ordered = db
      .prepare(`
        SELECT *,
          (matches_won + matches_lost + matches_drawn) AS total_matches
        FROM fighter WHERE active = 1
        ORDER BY total_matches ASC
      `)
      .all();
    // Take a window slightly bigger than needed (2x size) from the least-played,
    // then shuffle that window so adjacent ties are randomised.
    const windowSize = Math.min(ordered.length, size * 2);
    const pool = shuffle(ordered.slice(0, windowSize));
    return pool.slice(0, size);
  }

  // Default: random
  return shuffle(active).slice(0, size);
}

/**
 * Build round-1 pairings.
 * - 'random': just pair shuffled slots [0,1], [2,3], ...
 * - 'seeded': classic tournament seeding where seed i plays seed (size + 1 - i).
 *   Pairs are emitted in bracket order so winners' next-round pairings are correct.
 */
function buildRoundOnePairs(fighters, seeding) {
  const size = fighters.length;
  if (seeding === 'seeded') {
    // fighters are already ordered by seed (index 0 = seed 1)
    const pairs = [];
    const bracket = seededBracketOrder(size);
    for (let i = 0; i < bracket.length; i += 2) {
      pairs.push([fighters[bracket[i] - 1], fighters[bracket[i + 1] - 1]]);
    }
    return pairs;
  }
  // random: shuffle fighters, then pair
  const shuffled = shuffle(fighters);
  const pairs = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    pairs.push([shuffled[i], shuffled[i + 1]]);
  }
  return pairs;
}

/**
 * Standard seeded bracket ordering: produces the slot sequence so that seed 1 plays
 * seed N, seed 2 plays seed N-1, and winners of the top bracket meet in the final.
 * e.g. size=8 -> [1,8,4,5,2,7,3,6]
 */
function seededBracketOrder(size) {
  let list = [1];
  let rounds = Math.log2(size);
  for (let r = 0; r < rounds; r++) {
    const next = [];
    const currentSize = list.length * 2;
    for (const seed of list) {
      next.push(seed);
      next.push(currentSize + 1 - seed);
    }
    list = next;
  }
  return list;
}

export function createTournament({ size, name, selection = 'fresh', seeding = 'random', format = 'elimination' }) {
  if (!['elimination', 'roundrobin'].includes(format)) {
    throw new Error(`Invalid format: ${format}`);
  }
  if (format === 'elimination') {
    assertPowerOfTwo(size);
  } else if (size < 3) {
    throw new Error('Round-robin needs at least 3 fighters');
  }
  if (!['random', 'top', 'fresh'].includes(selection)) {
    throw new Error(`Invalid selection: ${selection}`);
  }
  if (!['random', 'seeded'].includes(seeding)) {
    throw new Error(`Invalid seeding: ${seeding}`);
  }
  if (seeding === 'seeded' && selection !== 'top' && format === 'elimination') {
    selection = 'top';
  }

  const db = getDb();
  const fighters = selectFighters(db, size, selection);
  const finalName = name || generateTournamentName();

  const insertTournament = db.prepare(
    'INSERT INTO tournament (name, size, selection, seeding, format) VALUES (?, ?, ?, ?, ?)'
  );
  const insertMatch = db.prepare(
    'INSERT INTO tournament_match (tournament_id, round, match_index, fighter_one_id, fighter_two_id) VALUES (?, ?, ?, ?, ?)'
  );

  let tournamentId;
  let pairs;

  if (format === 'roundrobin') {
    // Every fighter vs every other fighter, once.
    pairs = [];
    const shuffled = shuffle(fighters);
    for (let i = 0; i < shuffled.length; i++) {
      for (let j = i + 1; j < shuffled.length; j++) {
        pairs.push([shuffled[i], shuffled[j]]);
      }
    }
    pairs = shuffle(pairs); // randomize match order so it's fun to watch
    const txn = db.transaction(() => {
      const result = insertTournament.run(finalName, size, selection, seeding, 'roundrobin');
      tournamentId = result.lastInsertRowid;
      pairs.forEach((pair, idx) => {
        insertMatch.run(tournamentId, 1, idx, pair[0].id, pair[1].id);
      });
    });
    txn();
  } else {
    pairs = buildRoundOnePairs(fighters, seeding);
    const txn = db.transaction(() => {
      const result = insertTournament.run(finalName, size, selection, seeding, 'elimination');
      tournamentId = result.lastInsertRowid;
      pairs.forEach((pair, idx) => {
        insertMatch.run(tournamentId, 1, idx, pair[0].id, pair[1].id);
      });
    });
    txn();
  }

  return { tournamentId, fighters, pairs, name: finalName };
}

function pickActiveStage(db) {
  const stages = db.prepare('SELECT * FROM stage WHERE active = 1').all();
  if (stages.length === 0) {
    throw new Error('No active stages. Add some with: mugenbattle stages add <name>');
  }
  return pickRandom(stages);
}

function recordMatchStats(db, f1, f2, stage, result) {
  const updateWinner = db.prepare('UPDATE fighter SET matches_won = matches_won + 1 WHERE id = ?');
  const updateLoser = db.prepare('UPDATE fighter SET matches_lost = matches_lost + 1 WHERE id = ?');
  const updateDraw = db.prepare('UPDATE fighter SET matches_drawn = matches_drawn + 1 WHERE id = ?');
  const updateStage = db.prepare('UPDATE stage SET times_used = times_used + 1 WHERE id = ?');
  const insertHistory = db.prepare(
    'INSERT INTO fight_history (fighter_one_id, fighter_two_id, stage_id, victor_id) VALUES (?, ?, ?, ?)'
  );

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
}

async function resolveDraw(f1, f2, stage) {
  // Tournaments need a decisive winner — replay until one side wins.
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`  Draw — rematch ${attempt}...`);
    const result = await runMatch(f1.file_name, f2.file_name, stage.file_name);
    if (result.winner !== 'draw') return result;
  }
  // Final fallback: random coin flip
  console.log('  3 draws — flipping a coin.');
  return { winner: Math.random() < 0.5 ? 'fighter1' : 'fighter2', fighter1Rounds: 0, fighter2Rounds: 0 };
}

/**
 * Play one match to completion. Returns the winner fighter row.
 */
async function playMatch(db, matchRow) {
  const f1 = db.prepare('SELECT * FROM fighter WHERE id = ?').get(matchRow.fighter_one_id);
  const f2 = db.prepare('SELECT * FROM fighter WHERE id = ?').get(matchRow.fighter_two_id);
  const stage = pickActiveStage(db);

  // Pre-flight: verify both chars pass static validation. If one is broken,
  // declare the other the winner outright — no Ikemen launch, no modal.
  const f1v = validateFighter(f1.file_name);
  const f2v = validateFighter(f2.file_name);
  if (!f1v.ok || !f2v.ok) {
    if (!f1v.ok) {
      console.log(`  ⚠ ${f1.file_name} failed pre-flight (${f1v.reason}) — deactivating`);
      db.prepare('UPDATE fighter SET active = 0, validation_reason = ? WHERE id = ?').run(f1v.reason, f1.id);
      const n = cascadeWalkover(db, matchRow.tournament_id, f1.id);
      if (n > 0) console.log(`    · auto-walkover ${n} remaining matches`);
    }
    if (!f2v.ok) {
      console.log(`  ⚠ ${f2.file_name} failed pre-flight (${f2v.reason}) — deactivating`);
      db.prepare('UPDATE fighter SET active = 0, validation_reason = ? WHERE id = ?').run(f2v.reason, f2.id);
      const n = cascadeWalkover(db, matchRow.tournament_id, f2.id);
      if (n > 0) console.log(`    · auto-walkover ${n} remaining matches`);
    }
    const winner = !f1v.ok && f2v.ok ? f2 : !f2v.ok && f1v.ok ? f1 : Math.random() < 0.5 ? f1 : f2;
    db.prepare(
      'UPDATE tournament_match SET victor_id = ?, stage_id = ?, fought_at = datetime(\'now\') WHERE id = ?'
    ).run(winner.id, stage.id, matchRow.id);
    console.log(`  → ${winner.display_name || winner.file_name} (walkover)`);
    return winner;
  }

  console.log(`\n  ${f1.display_name || f1.file_name}  vs  ${f2.display_name || f2.file_name}   @ ${stage.display_name || stage.file_name}`);

  publishMatchState({
    f1: f1.display_name || f1.file_name,
    f1_fn: f1.file_name,
    f2: f2.display_name || f2.file_name,
    f2_fn: f2.file_name,
    stage: stage.display_name || stage.file_name,
    round: matchRow.round,
    tournament_id: matchRow.tournament_id,
    started_at: Date.now(),
  });

  let result;
  try {
    result = await runMatch(f1.file_name, f2.file_name, stage.file_name);
    if (result.winner === 'draw') {
      result = await resolveDraw(f1, f2, stage);
    }
  } catch (err) {
    // Match failed (usually a broken character or stage).
    // Inspect Ikemen error message to identify the broken fighter; deactivate it and advance the other side.
    const msg = String(err?.message || err);
    const broken = detectBrokenFighter(msg, [f1, f2]);
    if (broken) {
      console.log(`  ⚠ broken char detected: ${broken.file_name} — deactivating`);
      db.prepare('UPDATE fighter SET active = 0, validation_reason = ? WHERE id = ?').run('runtime_error', broken.id);
      const n = cascadeWalkover(db, matchRow.tournament_id, broken.id);
      if (n > 0) console.log(`    · auto-walkover ${n} remaining matches`);
      const winnerFighter = broken.id === f1.id ? 'fighter2' : 'fighter1';
      result = { winner: winnerFighter, fighter1Rounds: 0, fighter2Rounds: 0 };
    } else {
      console.log(`  ⚠ match errored and we can't tell who's broken — coin flip`);
      result = { winner: Math.random() < 0.5 ? 'fighter1' : 'fighter2', fighter1Rounds: 0, fighter2Rounds: 0 };
    }
  }
  const winner = result.winner === 'fighter1' ? f1 : f2;

  db.prepare(
    'UPDATE tournament_match SET victor_id = ?, stage_id = ?, fought_at = datetime(\'now\') WHERE id = ?'
  ).run(winner.id, stage.id, matchRow.id);

  recordMatchStats(db, f1, f2, stage, result);
  publishMatchState(null);

  console.log(`  → ${winner.display_name || winner.file_name}`);
  return winner;
}

function detectBrokenFighter(errorMsg, fighters) {
  // Ikemen errors typically include the path "chars/<name>/<name>.def" for the broken char.
  for (const f of fighters) {
    if (errorMsg.includes(`chars/${f.file_name}/`) || errorMsg.includes(`chars/${f.file_name}.def`)) {
      return f;
    }
  }
  return null;
}

/**
 * When a fighter is deactivated mid-tournament, walkover every pending match
 * they're scheduled for in this tournament so we don't relaunch Ikemen against
 * the same broken char again and risk a coin-flip wrong-decision.
 */
function cascadeWalkover(db, tournamentId, brokenFighterId) {
  const pending = db
    .prepare(
      'SELECT * FROM tournament_match WHERE tournament_id = ? AND victor_id IS NULL ' +
        'AND (fighter_one_id = ? OR fighter_two_id = ?)'
    )
    .all(tournamentId, brokenFighterId, brokenFighterId);
  if (pending.length === 0) return 0;
  const update = db.prepare(
    "UPDATE tournament_match SET victor_id = ?, fought_at = datetime('now') WHERE id = ?"
  );
  for (const m of pending) {
    const winnerId = m.fighter_one_id === brokenFighterId ? m.fighter_two_id : m.fighter_one_id;
    update.run(winnerId, m.id);
  }
  return pending.length;
}

function advanceRound(db, tournamentId, fromRound) {
  const matches = db
    .prepare(
      'SELECT * FROM tournament_match WHERE tournament_id = ? AND round = ? ORDER BY match_index'
    )
    .all(tournamentId, fromRound);

  if (matches.length === 1) {
    return null; // final — nothing to advance to
  }

  const insertMatch = db.prepare(
    'INSERT INTO tournament_match (tournament_id, round, match_index, fighter_one_id, fighter_two_id) VALUES (?, ?, ?, ?, ?)'
  );

  const nextRound = fromRound + 1;
  const txn = db.transaction(() => {
    for (let i = 0; i < matches.length; i += 2) {
      const a = matches[i];
      const b = matches[i + 1];
      insertMatch.run(tournamentId, nextRound, i / 2, a.victor_id, b.victor_id);
    }
  });
  txn();
  return nextRound;
}

export async function runTournament(tournamentId) {
  const db = getDb();
  const t = db.prepare('SELECT * FROM tournament WHERE id = ?').get(tournamentId);
  if (!t) throw new Error(`Tournament ${tournamentId} not found`);
  if (t.status === 'complete') {
    const winner = db.prepare('SELECT * FROM fighter WHERE id = ?').get(t.winner_id);
    console.log(`Tournament already complete — winner was ${winner?.display_name || winner?.file_name}`);
    return t;
  }

  if (t.format === 'roundrobin') {
    return runRoundRobin(db, t);
  }

  const rounds = Math.log2(t.size);
  const roundName = (r) => {
    const remaining = t.size / (2 ** (r - 1));
    if (remaining === 2) return 'Final';
    if (remaining === 4) return 'Semifinals';
    if (remaining === 8) return 'Quarterfinals';
    return `Round ${r} (${remaining} fighters)`;
  };

  console.log(`\n=== Tournament #${tournamentId} ${t.name ? `"${t.name}" ` : ''}(size ${t.size}, ${t.seeding} seeding) ===`);

  for (let r = 1; r <= rounds; r++) {
    const pending = db
      .prepare(
        'SELECT * FROM tournament_match WHERE tournament_id = ? AND round = ? AND victor_id IS NULL ORDER BY match_index'
      )
      .all(tournamentId, r);

    if (pending.length === 0) {
      // Check if round r has no matches at all — we need to advance from r-1
      const total = db
        .prepare('SELECT COUNT(*) as c FROM tournament_match WHERE tournament_id = ? AND round = ?')
        .get(tournamentId, r).c;
      if (total === 0 && r > 1) {
        advanceRound(db, tournamentId, r - 1);
        r -= 1;
        continue;
      }
      // Otherwise round complete already; move on
    }

    if (pending.length > 0) {
      console.log(`\n-- ${roundName(r)} --`);
      for (const m of pending) {
        await playMatch(db, m);
      }
    }

    if (r < rounds) {
      const existing = db
        .prepare('SELECT COUNT(*) as c FROM tournament_match WHERE tournament_id = ? AND round = ?')
        .get(tournamentId, r + 1).c;
      if (existing === 0) {
        advanceRound(db, tournamentId, r);
      }
    }
  }

  // Final winner = victor of the last round's only match
  const finalMatch = db
    .prepare(
      'SELECT * FROM tournament_match WHERE tournament_id = ? AND round = ? ORDER BY match_index'
    )
    .get(tournamentId, rounds);
  if (finalMatch?.victor_id) {
    db.prepare(
      'UPDATE tournament SET winner_id = ?, status = ?, completed_at = datetime(\'now\') WHERE id = ?'
    ).run(finalMatch.victor_id, 'complete', tournamentId);
    const winner = db.prepare('SELECT * FROM fighter WHERE id = ?').get(finalMatch.victor_id);
    console.log(`\n🏆  WINNER: ${winner.display_name || winner.file_name}`);
    if (winner.author) console.log(`     (by ${winner.author})`);
  }

  return db.prepare('SELECT * FROM tournament WHERE id = ?').get(tournamentId);
}

async function runRoundRobin(db, t) {
  console.log(`\n=== Round-Robin #${t.id} "${t.name || ''}" (${t.size} fighters, ${(t.size * (t.size - 1)) / 2} matches) ===`);

  const matches = db
    .prepare(
      'SELECT * FROM tournament_match WHERE tournament_id = ? AND victor_id IS NULL ORDER BY match_index'
    )
    .all(t.id);

  for (const m of matches) {
    await playMatch(db, m);
  }

  // Compute standings
  const standings = db
    .prepare(`
      SELECT f.id, f.file_name, f.display_name,
        SUM(CASE WHEN tm.victor_id = f.id THEN 1 ELSE 0 END) AS wins,
        COUNT(*) AS played
      FROM fighter f
      JOIN tournament_match tm ON (tm.fighter_one_id = f.id OR tm.fighter_two_id = f.id)
      WHERE tm.tournament_id = ?
      GROUP BY f.id
      ORDER BY wins DESC, f.file_name ASC
    `)
    .all(t.id);

  console.log('\n--- Final Standings ---');
  standings.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.display_name || s.file_name}  ${s.wins} W / ${s.played - s.wins} L`);
  });

  const winner = standings[0];
  if (winner) {
    db.prepare(
      'UPDATE tournament SET winner_id = ?, status = ?, completed_at = datetime(\'now\') WHERE id = ?'
    ).run(winner.id, 'complete', t.id);
    console.log(`\n🏆  CHAMPION: ${winner.display_name || winner.file_name}  (${winner.wins} wins)`);
  }
  return db.prepare('SELECT * FROM tournament WHERE id = ?').get(t.id);
}

export function listTournaments() {
  const db = getDb();
  return db
    .prepare(
      `SELECT t.*, f.file_name AS winner_name, f.display_name AS winner_display
       FROM tournament t
       LEFT JOIN fighter f ON t.winner_id = f.id
       ORDER BY t.id DESC`
    )
    .all();
}

export function showTournament(tournamentId) {
  const db = getDb();
  const t = db.prepare('SELECT * FROM tournament WHERE id = ?').get(tournamentId);
  if (!t) throw new Error(`Tournament ${tournamentId} not found`);
  const matches = db
    .prepare(
      `SELECT tm.*, f1.file_name AS f1_name, f1.display_name AS f1_display,
              f2.file_name AS f2_name, f2.display_name AS f2_display,
              v.file_name AS v_name, v.display_name AS v_display,
              s.file_name AS stage_name
       FROM tournament_match tm
       LEFT JOIN fighter f1 ON tm.fighter_one_id = f1.id
       LEFT JOIN fighter f2 ON tm.fighter_two_id = f2.id
       LEFT JOIN fighter v ON tm.victor_id = v.id
       LEFT JOIN stage s ON tm.stage_id = s.id
       WHERE tournament_id = ?
       ORDER BY round, match_index`
    )
    .all(tournamentId);
  return { tournament: t, matches };
}
