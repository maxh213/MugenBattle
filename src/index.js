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
import { credit, assertLedgerIntegrity } from './wallet.js';
import { runOwnedFighterMatch } from './match.js';
import { readEffectiveStamina } from './stamina.js';
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
  .description('Create and run a new tournament (single-elimination or round-robin)')
  .requiredOption('-s, --size <n>', 'fighter count (elimination: power of 2; roundrobin: any >= 3)', (v) => parseInt(v, 10))
  .option('-n, --name <name>', 'tournament name (auto-generated if omitted)')
  .option('-f, --format <kind>', 'elimination | roundrobin', 'elimination')
  .option('--selection <kind>', 'fighter selection: fresh (least-played) | random | top', 'fresh')
  .option('--seeding <kind>', 'bracket seeding (elimination only): random or seeded', 'random')
  .action(async (opts) => {
    const { tournamentId, fighters, name } = createTournament({
      size: opts.size,
      name: opts.name,
      format: opts.format,
      selection: opts.selection,
      seeding: opts.seeding,
    });
    console.log(`Created tournament #${tournamentId} "${name}" with ${fighters.length} fighters (${opts.format}).`);
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
    console.log(`\n${'#'.padStart(4)} ${'Size'.padStart(5)} ${'Format'.padEnd(11)} ${'Status'.padEnd(10)} ${'Winner'.padEnd(25)} Name`);
    console.log('-'.repeat(90));
    for (const t of rows) {
      const winner = t.winner_display || t.winner_name || (t.status === 'complete' ? '(unknown)' : '(tbd)');
      const format = t.format || 'elimination';
      console.log(
        `${String(t.id).padStart(4)} ${String(t.size).padStart(5)} ${format.padEnd(11)} ${t.status.padEnd(10)} ${winner.slice(0, 25).padEnd(25)} ${t.name || ''}`
      );
    }
  });

tournament
  .command('show <id>')
  .description('Show bracket / standings for a tournament')
  .action((id) => {
    const { tournament: t, matches } = showTournament(parseInt(id, 10));
    console.log(`\nTournament #${t.id}${t.name ? ` — ${t.name}` : ''}`);
    console.log(`Size ${t.size}, format=${t.format || 'elimination'}, selection=${t.selection}, status=${t.status}`);

    if ((t.format || 'elimination') === 'roundrobin') {
      // Standings table
      const wins = new Map();
      const played = new Map();
      const fighterName = new Map();
      for (const m of matches) {
        const a = m.fighter_one_id, b = m.fighter_two_id;
        fighterName.set(a, m.f1_display || m.f1_name || `#${a}`);
        fighterName.set(b, m.f2_display || m.f2_name || `#${b}`);
        if (m.victor_id != null) {
          played.set(a, (played.get(a) || 0) + 1);
          played.set(b, (played.get(b) || 0) + 1);
          wins.set(m.victor_id, (wins.get(m.victor_id) || 0) + 1);
        }
      }
      const standings = [...new Set([...wins.keys(), ...played.keys(), ...fighterName.keys()])]
        .map((id) => ({ id, name: fighterName.get(id), w: wins.get(id) || 0, p: played.get(id) || 0 }))
        .sort((a, b) => b.w - a.w || a.name.localeCompare(b.name));
      console.log('\n  Standings');
      standings.forEach((s, i) => console.log(`    ${String(i + 1).padStart(2)}. ${s.name.padEnd(28)} ${s.w}W / ${s.p - s.w}L`));
      const completed = matches.filter((m) => m.victor_id).length;
      console.log(`\n  Completed: ${completed} / ${matches.length} matches`);
      return;
    }

    // Elimination bracket
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

// --- Users (admin) ---

const users = program.command('users').description('Admin: manage user accounts');

users
  .command('list')
  .description('List all users + team + balance')
  .action(() => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT u.id, u.email, u.username, u.balance_cents, u.is_banned, u.banned_reason,
        t.id AS team_id, t.name AS team_name,
        (SELECT COUNT(*) FROM owned_fighter WHERE team_id = t.id) AS roster_size
      FROM user_account u
      LEFT JOIN team t ON t.user_id = u.id
      ORDER BY u.id
    `).all();
    if (rows.length === 0) {
      console.log('No users yet.');
      return;
    }
    console.log(`\n${'#'.padStart(4)} ${'Username'.padEnd(20)} ${'Email'.padEnd(30)} ${'Balance'.padStart(10)} ${'Team'.padEnd(25)} ${'Roster'.padStart(6)} Ban`);
    console.log('-'.repeat(110));
    for (const r of rows) {
      const ban = r.is_banned ? `BANNED (${r.banned_reason || '?'})` : '';
      console.log(
        `${String(r.id).padStart(4)} ${(r.username || '(pending)').padEnd(20)} ${(r.email || '').padEnd(30)} ${String(r.balance_cents).padStart(10)} ${(r.team_name || '—').slice(0, 25).padEnd(25)} ${String(r.roster_size || 0).padStart(6)} ${ban}`
      );
    }
  });

users
  .command('ban <username>')
  .description('Ban a user')
  .option('-r, --reason <text>', 'reason for the ban', 'TOS violation')
  .action((username, opts) => {
    const db = getDb();
    const r = db.prepare('UPDATE user_account SET is_banned = 1, banned_reason = ? WHERE username = ?').run(opts.reason, username);
    console.log(r.changes ? `Banned ${username}.` : `No user named "${username}".`);
  });

users
  .command('unban <username>')
  .description('Unban a user')
  .action((username) => {
    const db = getDb();
    const r = db.prepare('UPDATE user_account SET is_banned = 0, banned_reason = NULL WHERE username = ?').run(username);
    console.log(r.changes ? `Unbanned ${username}.` : `No user named "${username}".`);
  });

users
  .command('credit')
  .description('Credit or debit a user\'s balance (records to ledger)')
  .requiredOption('-u, --username <name>', 'username')
  .requiredOption('-c, --cents <n>', 'cents (positive credit, negative debit)', (v) => parseInt(v, 10))
  .option('-r, --reason <text>', 'reason string for the ledger', 'admin')
  .action((opts) => {
    const db = getDb();
    const u = db.prepare('SELECT id FROM user_account WHERE username = ?').get(opts.username);
    if (!u) { console.log(`No user named "${opts.username}".`); return; }
    const newBal = credit(db, u.id, opts.cents, opts.reason);
    console.log(`${opts.username} balance: ${newBal} cents`);
  });

users
  .command('check-ledger')
  .description('Assert ledger sums match materialised balances')
  .action(() => {
    const db = getDb();
    const bad = assertLedgerIntegrity(db);
    if (bad.length === 0) {
      console.log('OK — all balances match ledger sums.');
    } else {
      console.log(`MISMATCH on ${bad.length} user(s):`);
      for (const r of bad) {
        console.log(`  ${r.username} (id=${r.id}): materialised=${r.materialised} ledger=${r.ledger_sum}`);
      }
    }
  });

// --- Owned-fighter matches (for testing / manual play) ---

program
  .command('owned-match <home_id> <away_id>')
  .description('Run a single owned-vs-owned match (for testing)')
  .option('-s, --stage <name>', 'stage file_name (default: random active)', null)
  .action(async (homeId, awayId, opts) => {
    const db = getDb();
    let stage = opts.stage;
    if (!stage) {
      const row = db.prepare('SELECT file_name FROM stage WHERE active = 1 ORDER BY RANDOM() LIMIT 1').get();
      if (!row) { console.error('No active stages.'); return; }
      stage = row.file_name;
    }
    const home = db.prepare('SELECT id, display_name FROM owned_fighter WHERE id = ?').get(parseInt(homeId, 10));
    const away = db.prepare('SELECT id, display_name FROM owned_fighter WHERE id = ?').get(parseInt(awayId, 10));
    if (!home || !away) { console.error('owned_fighter not found'); return; }

    console.log(`\n${home.display_name} (id=${home.id}) vs ${away.display_name} (id=${away.id}) @ ${stage}`);
    console.log(`  pre-stamina home=${readEffectiveStamina(db, home.id).toFixed(2)} away=${readEffectiveStamina(db, away.id).toFixed(2)}`);

    try {
      const r = await runOwnedFighterMatch({
        db,
        homeOwnedFighterId: home.id,
        awayOwnedFighterId: away.id,
        stageFileName: stage,
      });
      console.log(`  lives home=${r.homeLife} away=${r.awayLife}`);
      const winner = r.winner === 'fighter1' ? r.home.name
                   : r.winner === 'fighter2' ? r.away.name
                   : 'draw';
      console.log(`  → ${winner} (${r.fighter1Rounds}-${r.fighter2Rounds})`);
      console.log(`  post-stamina home=${readEffectiveStamina(db, home.id).toFixed(2)} away=${readEffectiveStamina(db, away.id).toFixed(2)}`);
    } catch (err) {
      console.error('Match failed:', err.message);
    }
  });

program.hook('postAction', () => {
  closeDb();
});

program.parse();
