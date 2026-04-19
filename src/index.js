#!/usr/bin/env node

import { program } from 'commander';
import {
  addFighter,
  addStage,
  listFighters,
  listStages,
  removeFighter,
  removeStage,
  getStats,
  getHistory,
  runSingleMatch,
  backfillAuthors,
} from './tournament.js';
import {
  createTournament,
  runTournament,
  listTournaments,
  showTournament,
} from './brackets.js';
import { validateAllActive, validateFighter } from './validator.js';
import { getDb } from './db.js';
import { closeDb } from './db.js';

program
  .name('mugenbattle')
  .description('Automated MUGEN AI fighting tournament runner')
  .version('2.0.0');

// --- Run matches ---

program
  .command('run')
  .description('Run random AI matches')
  .option('-c, --count <n>', 'number of matches to run', '1')
  .action(async (opts) => {
    const count = parseInt(opts.count, 10);
    console.log(`Running ${count} match${count > 1 ? 'es' : ''}...`);

    for (let i = 0; i < count; i++) {
      if (count > 1) console.log(`\n--- Match ${i + 1} of ${count} ---`);
      await runSingleMatch();
    }

    console.log('\nDone!');
  });

// --- Fighters ---

const fighters = program.command('fighters').description('Manage fighters');

fighters
  .command('list')
  .description('List all fighters')
  .action(() => {
    const rows = listFighters();
    if (rows.length === 0) {
      console.log('No fighters yet. Add some with: mugenbattle fighters add <name>');
      return;
    }
    console.log(
      `\n${'Name'.padEnd(25)} ${'Author'.padEnd(22)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'D'.padStart(4)} Active`
    );
    console.log('-'.repeat(75));
    for (const f of rows) {
      const active = f.active ? 'yes' : 'no';
      const author = (f.author || '').slice(0, 22);
      console.log(
        `${f.file_name.padEnd(25)} ${author.padEnd(22)} ${String(f.matches_won).padStart(4)} ${String(f.matches_lost).padStart(4)} ${String(f.matches_drawn).padStart(4)} ${active}`
      );
    }
  });

fighters
  .command('add <name>')
  .description('Add a fighter (use the MUGEN character folder name)')
  .option('-d, --display <name>', 'display name')
  .option('-a, --author <name>', 'author/creator name (defaults to .def [Info] author)')
  .option('-s, --source <url>', 'source URL where the character was obtained')
  .action((name, opts) => {
    try {
      addFighter(name, { displayName: opts.display, author: opts.author, sourceUrl: opts.source });
      console.log(`Added fighter: ${name}`);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        console.log(`Fighter "${name}" already exists.`);
      } else {
        throw err;
      }
    }
  });

fighters
  .command('backfill-authors')
  .description('Read author + displayname from each character\'s .def file and populate the DB')
  .action(() => {
    const count = backfillAuthors();
    console.log(`Backfilled ${count} row(s) from .def metadata.`);
  });

fighters
  .command('validate')
  .description('Static check of active fighters; deactivates broken ones (missing files, malformed cmd)')
  .option('--force', 'revalidate all active fighters, even those already checked')
  .action((opts) => {
    const db = getDb();
    const r = validateAllActive(db, { force: opts.force });
    console.log(`Validated ${r.total}: ${r.ok} ok, ${r.bad} deactivated`);
    if (r.bad > 0) {
      console.log('Failure reasons:');
      for (const [reason, n] of Object.entries(r.reasons).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${reason.padEnd(25)} ${n}`);
      }
    }
  });

fighters
  .command('remove <name>')
  .description('Remove a fighter')
  .action((name) => {
    if (removeFighter(name)) {
      console.log(`Removed fighter: ${name}`);
    } else {
      console.log(`Fighter "${name}" not found.`);
    }
  });

// --- Stages ---

const stages = program.command('stages').description('Manage stages');

stages
  .command('list')
  .description('List all stages')
  .action(() => {
    const rows = listStages();
    if (rows.length === 0) {
      console.log('No stages yet. Add some with: mugenbattle stages add <name>');
      return;
    }
    console.log(`\n${'Name'.padEnd(25)} ${'Author'.padEnd(22)} ${'Used'.padStart(5)} Active`);
    console.log('-'.repeat(65));
    for (const s of rows) {
      const active = s.active ? 'yes' : 'no';
      const author = (s.author || '').slice(0, 22);
      console.log(`${s.file_name.padEnd(25)} ${author.padEnd(22)} ${String(s.times_used).padStart(5)} ${active}`);
    }
  });

stages
  .command('add <name>')
  .description('Add a stage (use the MUGEN stage folder name)')
  .option('-d, --display <name>', 'display name')
  .option('-a, --author <name>', 'author/creator name (defaults to .def [Info] author)')
  .option('-s, --source <url>', 'source URL where the stage was obtained')
  .action((name, opts) => {
    try {
      addStage(name, { displayName: opts.display, author: opts.author, sourceUrl: opts.source });
      console.log(`Added stage: ${name}`);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        console.log(`Stage "${name}" already exists.`);
      } else {
        throw err;
      }
    }
  });

stages
  .command('remove <name>')
  .description('Remove a stage')
  .action((name) => {
    if (removeStage(name)) {
      console.log(`Removed stage: ${name}`);
    } else {
      console.log(`Stage "${name}" not found.`);
    }
  });

// --- Stats ---

program
  .command('stats')
  .description('Show fighter leaderboard')
  .action(() => {
    const rows = getStats();
    if (rows.length === 0) {
      console.log('No stats yet. Run some matches first!');
      return;
    }
    console.log(
      `\n${'#'.padStart(3)} ${'Fighter'.padEnd(25)} ${'W'.padStart(5)} ${'L'.padStart(5)} ${'D'.padStart(5)} ${'Total'.padStart(6)} ${'Win%'.padStart(6)}`
    );
    console.log('-'.repeat(62));
    rows.forEach((f, i) => {
      console.log(
        `${String(i + 1).padStart(3)} ${f.file_name.padEnd(25)} ${String(f.matches_won).padStart(5)} ${String(f.matches_lost).padStart(5)} ${String(f.matches_drawn).padStart(5)} ${String(f.total_matches).padStart(6)} ${String(f.win_rate + '%').padStart(6)}`
      );
    });
  });

// --- History ---

program
  .command('history')
  .description('Show recent fight history')
  .option('-n, --limit <n>', 'number of fights to show', '20')
  .action((opts) => {
    const rows = getHistory(parseInt(opts.limit, 10));
    if (rows.length === 0) {
      console.log('No fight history yet. Run some matches first!');
      return;
    }
    console.log(`\n${'Fighter 1'.padEnd(20)} ${'Fighter 2'.padEnd(20)} ${'Stage'.padEnd(20)} ${'Victor'.padEnd(20)} Date`);
    console.log('-'.repeat(95));
    for (const r of rows) {
      const victor = r.victor || 'DRAW';
      const date = r.fought_at?.slice(0, 10) || '';
      console.log(
        `${r.fighter1.padEnd(20)} ${r.fighter2.padEnd(20)} ${r.stage.padEnd(20)} ${victor.padEnd(20)} ${date}`
      );
    }
  });

// --- Tournaments ---

const tournament = program.command('tournament').description('Bracket tournaments');

tournament
  .command('start')
  .description('Create and run a new single-elimination tournament')
  .requiredOption('-s, --size <n>', 'bracket size (power of 2: 2, 4, 8, 16, 32, 64, ...)', (v) => parseInt(v, 10))
  .option('-n, --name <name>', 'tournament name')
  .option('--selection <kind>', 'fighter selection: fresh (least-played) | random | top', 'fresh')
  .option('--seeding <kind>', 'bracket seeding: random or seeded', 'random')
  .action(async (opts) => {
    const { tournamentId, fighters } = createTournament({
      size: opts.size,
      name: opts.name,
      selection: opts.selection,
      seeding: opts.seeding,
    });
    console.log(`Created tournament #${tournamentId} with ${fighters.length} fighters.`);
    await runTournament(tournamentId);
  });

tournament
  .command('resume <id>')
  .description('Resume a tournament that was interrupted mid-run')
  .action(async (id) => {
    await runTournament(parseInt(id, 10));
  });

tournament
  .command('list')
  .description('List all tournaments')
  .action(() => {
    const rows = listTournaments();
    if (rows.length === 0) {
      console.log('No tournaments yet. Start one with: mugenbattle tournament start --size 8');
      return;
    }
    console.log(`\n${'#'.padStart(4)} ${'Size'.padStart(5)} ${'Status'.padEnd(10)} ${'Seeding'.padEnd(8)} ${'Winner'.padEnd(25)} Name`);
    console.log('-'.repeat(85));
    for (const t of rows) {
      const winner = t.winner_display || t.winner_name || (t.status === 'complete' ? '(unknown)' : '(tbd)');
      console.log(
        `${String(t.id).padStart(4)} ${String(t.size).padStart(5)} ${t.status.padEnd(10)} ${(t.seeding || '').padEnd(8)} ${winner.slice(0, 25).padEnd(25)} ${t.name || ''}`
      );
    }
  });

tournament
  .command('show <id>')
  .description('Show bracket state for a tournament')
  .action((id) => {
    const { tournament: t, matches } = showTournament(parseInt(id, 10));
    console.log(`\nTournament #${t.id}${t.name ? ` — ${t.name}` : ''}`);
    console.log(`Size ${t.size}, seeding=${t.seeding}, selection=${t.selection}, status=${t.status}`);
    if (t.status === 'complete') {
      const winner = matches[matches.length - 1];
      console.log(`Winner: ${winner?.v_display || winner?.v_name}`);
    }
    const byRound = {};
    for (const m of matches) {
      (byRound[m.round] ||= []).push(m);
    }
    const roundCount = Math.log2(t.size);
    const roundLabel = (r) => {
      const remaining = t.size / (2 ** (r - 1));
      if (remaining === 2) return 'Final';
      if (remaining === 4) return 'Semifinals';
      if (remaining === 8) return 'Quarterfinals';
      return `Round of ${remaining}`;
    };
    for (let r = 1; r <= roundCount; r++) {
      const rMatches = byRound[r] || [];
      if (rMatches.length === 0) continue;
      console.log(`\n  ${roundLabel(r)}`);
      for (const m of rMatches) {
        const f1 = m.f1_display || m.f1_name || '(?)';
        const f2 = m.f2_display || m.f2_name || '(?)';
        const v = m.v_display || m.v_name || '';
        const line = v
          ? `    ${f1.padEnd(22)} vs ${f2.padEnd(22)} → ${v}${m.stage_name ? `  @ ${m.stage_name}` : ''}`
          : `    ${f1.padEnd(22)} vs ${f2.padEnd(22)}   (pending)`;
        console.log(line);
      }
    }
  });

program.hook('postAction', () => {
  closeDb();
});

program.parse();
