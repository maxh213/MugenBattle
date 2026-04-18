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

program.hook('postAction', () => {
  closeDb();
});

program.parse();
