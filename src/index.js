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
import {
  createSeason,
  pickNextFixture,
  runFixture,
  getStandings,
  listLeagues,
  computeNextSeasonSeating,
} from './leagues.js';
import { runLeagueWorker } from './leagueWorker.js';
import { bootstrapTeamForUser } from './teams.js';
import { seedBots, retireAllBotRosters, listBots } from './bots.js';
import { marketListings, priceFor } from './market.js';
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

// --- Users: admin user creation (skips email-code step) ---

users
  .command('create <username> <email>')
  .description('Create a user + starter team (admin shortcut; skips email verification)')
  .action((username, email) => {
    const db = getDb();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      console.error('Username must be 3–20 chars, letters/numbers/underscore only.');
      return;
    }
    const emailNorm = email.trim().toLowerCase();
    try {
      const tx = db.transaction(() => {
        const existing = db.prepare('SELECT id FROM user_account WHERE email = ? OR lower(username) = lower(?)').get(emailNorm, username);
        if (existing) throw new Error(`User already exists (email or username)`);
        const r = db.prepare('INSERT INTO user_account (email, username) VALUES (?, ?)').run(emailNorm, username);
        const userId = r.lastInsertRowid;
        const teamId = bootstrapTeamForUser(db, userId, username + "'s Team");
        return { userId, teamId };
      });
      const { userId, teamId } = tx();
      console.log(`Created user ${username} (#${userId}) + team #${teamId}.`);
    } catch (err) {
      console.error('Failed:', err.message);
    }
  });

// --- Leagues ---

const league = program.command('league').description('Seasons, divisions, fixtures');

league
  .command('create')
  .description('Create a season. Uses prev-season standings for tier assignment (promotion/relegation); bots + new signups fill remaining slots.')
  .option('-n, --name <text>', 'season name')
  .option('-d, --divisions <n>', 'number of divisions (tier 1 = top)', (v) => parseInt(v, 10), 3)
  .option('-p, --per-division <n>', 'teams per division', (v) => parseInt(v, 10), 8)
  .option('-l, --legs <n>', 'legs per round-robin (1 = single, 2 = home+away)', (v) => parseInt(v, 10), 1)
  .option('--promote-per-tier <n>', 'top-N promote / bottom-N relegate between tiers', (v) => parseInt(v, 10), 2)
  .action((opts) => {
    const db = getDb();
    const divCount = Math.max(1, opts.divisions);
    const perDiv = Math.max(2, opts.perDivision);
    const totalSlots = divCount * perDiv;

    // Pre-seat from prev-season standings if a completed league of matching
    // shape exists. Otherwise start empty and let everyone go to bottom tier.
    const pr = computeNextSeasonSeating(db, {
      divCount, perDiv, promotePerTier: opts.promotePerTier,
    });

    const divisions = pr
      ? pr.divisions.map((d) => ({ name: d.name, teamIds: [...d.teamIds] }))
      : Array.from({ length: divCount }, (_, i) => ({ name: `Division ${i + 1}`, teamIds: [] }));
    const dropped = pr ? [...pr.dropped] : [];
    const alreadySeated = new Set(divisions.flatMap((d) => d.teamIds));
    // Dropped teams from the last bottom-of-bottom sit out THIS season — they
    // become eligible again for the season after. Excluding them from the
    // new-real-team pool enforces that "skip a cycle" penalty.
    const excluded = new Set([...alreadySeated, ...dropped]);

    // Bottom tier absorbs new signups. Only real teams not in the prev
    // season (fresh waitlist) go here; returning users were seated above.
    const newRealTeams = db.prepare(`
      SELECT t.id FROM team t
      JOIN user_account u ON t.user_id = u.id
      WHERE u.is_bot = 0
        AND t.current_league_id IS NULL
        AND (SELECT COUNT(*) FROM owned_fighter WHERE team_id = t.id AND is_retired = 0 AND slot = 'active') >= 5
      ORDER BY t.id
    `).all().map((r) => r.id).filter((id) => !excluded.has(id));

    const bottom = divisions[divCount - 1];
    const bottomSpace = () => perDiv - bottom.teamIds.length;
    const newSeated = [];
    while (newRealTeams.length && bottomSpace() > 0) {
      const id = newRealTeams.shift();
      bottom.teamIds.push(id);
      newSeated.push(id);
    }
    const waitingReal = newRealTeams.length;

    // Fill any remaining per-tier gaps with bots. Seed bot roster as needed.
    const gaps = divisions.reduce((sum, d) => sum + (perDiv - d.teamIds.length), 0);
    const allBots = seedBots(db, Math.max(1, gaps));  // min 1 to avoid seedBots(0) corner
    const botIdsReady = allBots
      .filter((b) => {
        const t = db.prepare('SELECT current_league_id FROM team WHERE id = ?').get(b.team_id);
        return t.current_league_id == null && !excluded.has(b.team_id);
      })
      .map((b) => b.team_id);

    let botIdx = 0;
    for (const d of divisions) {
      while (d.teamIds.length < perDiv && botIdx < botIdsReady.length) {
        d.teamIds.push(botIdsReady[botIdx++]);
      }
    }

    const botsUsed = botIdx;
    const totalFilled = divisions.reduce((s, d) => s + d.teamIds.length, 0);
    if (totalFilled < totalSlots) {
      console.error(`Only filled ${totalFilled}/${totalSlots} slots. Increase bots or reduce divisions.`);
      return;
    }

    const name = opts.name || `Season ${new Date().toISOString().slice(0, 10)}`;
    try {
      const leagueId = createSeason(db, { name, divisions, legs: opts.legs });
      const fixtureCount = db.prepare(`
        SELECT COUNT(*) AS n FROM fixture f
        JOIN division d ON f.division_id = d.id WHERE d.league_id = ?
      `).get(leagueId).n;
      console.log(`Created league #${leagueId} "${name}": ${divCount} divisions × ${perDiv} teams = ${totalSlots} slots, ${fixtureCount} fixtures.`);
      if (pr) {
        console.log(`  Seeded from prev standings (promote-per-tier=${opts.promotePerTier}); new signups: ${newSeated.length}, dropped: ${dropped.length}; bots: ${botsUsed}.`);
      } else {
        console.log(`  Fresh seeding (no prev season); new real teams: ${newSeated.length}; bots: ${botsUsed}.`);
      }
      if (waitingReal > 0) console.log(`  ${waitingReal} real team(s) waiting for next season.`);
      if (dropped.length > 0) console.log(`  Dropped to waitlist (bottom-of-bottom): teams ${dropped.join(', ')}`);
      for (const d of divisions) {
        console.log(`  ${d.name}: teams ${d.teamIds.join(', ')}`);
      }
    } catch (err) {
      console.error('Failed:', err.message);
    }
  });

league
  .command('list')
  .description('List all leagues')
  .action(() => {
    const db = getDb();
    const rows = listLeagues(db);
    if (rows.length === 0) { console.log('No leagues yet.'); return; }
    console.log(`\n${'#'.padStart(4)} ${'Name'.padEnd(30)} ${'Status'.padEnd(10)} ${'Divs'.padStart(4)} ${'Done'.padStart(6)} ${'Total'.padStart(6)} Started`);
    console.log('-'.repeat(85));
    for (const l of rows) {
      const progress = `${l.fixtures_done}/${l.fixture_count}`;
      console.log(`${String(l.id).padStart(4)} ${(l.name || '').slice(0, 30).padEnd(30)} ${l.status.padEnd(10)} ${String(l.division_count).padStart(4)} ${String(l.fixtures_done).padStart(6)} ${String(l.fixture_count).padStart(6)} ${l.started_at || ''}`);
    }
  });

league
  .command('run-next')
  .description('Run the next pending fixture from any running league')
  .option('-l, --league <id>', 'restrict to a single league', (v) => parseInt(v, 10))
  .option('-c, --count <n>', 'run up to N fixtures in a row', (v) => parseInt(v, 10), 1)
  .action(async (opts) => {
    const db = getDb();
    for (let i = 0; i < opts.count; i++) {
      const next = pickNextFixture(db, { leagueId: opts.league });
      if (!next) {
        console.log('No pending fixtures.');
        break;
      }
      const home = db.prepare('SELECT name FROM team WHERE id = ?').get(next.home_team_id);
      const away = db.prepare('SELECT name FROM team WHERE id = ?').get(next.away_team_id);
      console.log(`\n[fixture #${next.id}] ${home.name} (home) vs ${away.name} — round ${next.round_num} slot ${next.slot_num}`);
      try {
        const r = await runFixture(db, next.id);
        if (r.forfeit) {
          console.log(`  FORFEIT: ${r.homeScore}-${r.awayScore}`);
        } else {
          console.log(`  stage: ${r.stage}`);
          for (const s of r.slots) {
            console.log(`    slot ${s.slot}: ${s.home.name.padEnd(20)} vs ${s.away.name.padEnd(20)} → ${s.winner} (${s.homeRounds}-${s.awayRounds})`);
          }
          console.log(`  FINAL: ${r.homeScore}-${r.awayScore}`);
        }
      } catch (err) {
        console.error('  Fixture failed:', err.message);
        break;
      }
    }
  });

league
  .command('worker <id>')
  .description('Run all remaining fixtures for a league until complete')
  .option('--log <path>', 'per-worker Ikemen log file (isolates from other workers)')
  .option('--display <name>', 'per-worker X DISPLAY (e.g. :100)')
  .option('--speed <pct>', 'Ikemen speed (10-200) or "speedtest" for ~100x. Smokes only.')
  .action(async (id, opts) => {
    const db = getDb();
    const leagueId = parseInt(id, 10);
    const ctx = {};
    if (opts.log) ctx.logPath = opts.log;
    if (opts.display) ctx.display = opts.display;
    if (opts.speed) ctx.speed = opts.speed;

    const r = await runLeagueWorker(db, leagueId, ctx, {
      onFixtureStart: (f) => {
        const home = db.prepare('SELECT name FROM team WHERE id = ?').get(f.home_team_id);
        const away = db.prepare('SELECT name FROM team WHERE id = ?').get(f.away_team_id);
        console.log(`\n[worker ${leagueId}] fixture #${f.id}: ${home.name} vs ${away.name} (R${f.round_num}.${f.slot_num})`);
      },
      onFixtureEnd: (f, result) => {
        console.log(`  → ${result.homeScore}-${result.awayScore}${result.forfeit ? ' (forfeit)' : ''}`);
      },
      onError: (f, err) => {
        console.error(`  fixture #${f.id} failed: ${err.message.split('\n')[0]}`);
        return false;
      },
    });
    console.log(`\n[worker ${leagueId}] done: ${r.fixturesRun} fixture(s) run${r.stopped ? ' (stopped)' : ''}`);
  });

league
  .command('standings <id>')
  .description('Show standings for a league')
  .action((id) => {
    const db = getDb();
    const data = getStandings(db, parseInt(id, 10));
    if (!data) { console.log('League not found.'); return; }
    console.log(`\nLeague #${data.league.id} — ${data.league.name} (${data.league.status})`);
    console.log(`Pending fixtures: ${data.pending}`);
    for (const d of data.divisions) {
      console.log(`\n  ${d.name} (tier ${d.tier})`);
      console.log(`    ${'Pos'.padStart(3)} ${'Team'.padEnd(28)} ${'Pl'.padStart(3)} ${'W'.padStart(3)} ${'D'.padStart(3)} ${'L'.padStart(3)} ${'MW'.padStart(4)} ${'ML'.padStart(4)} ${'Pts'.padStart(4)}`);
      console.log('    ' + '-'.repeat(72));
      d.standings.forEach((s, i) => {
        const label = `${s.team_name} (@${s.username})`;
        console.log(
          `    ${String(i + 1).padStart(3)} ${label.slice(0, 28).padEnd(28)} ${String(s.fixtures_played).padStart(3)} ${String(s.fixtures_won).padStart(3)} ${String(s.fixtures_drawn).padStart(3)} ${String(s.fixtures_lost).padStart(3)} ${String(s.matches_won).padStart(4)} ${String(s.matches_lost).padStart(4)} ${String(s.points).padStart(4)}`
        );
      });
    }
  });

// --- Bots ---

const bots = program.command('bots').description('Bot players (fill empty league slots)');

bots
  .command('list')
  .description('List all bots')
  .action(() => {
    const db = getDb();
    const rows = listBots(db);
    if (rows.length === 0) { console.log('No bots yet.'); return; }
    console.log(`\n${'#'.padStart(4)} ${'Username'.padEnd(14)} ${'Team'.padStart(5)} ${'Roster'.padStart(6)} ${'League'.padStart(7)}`);
    console.log('-'.repeat(45));
    for (const b of rows) {
      console.log(`${String(b.user_id).padStart(4)} ${b.username.padEnd(14)} ${String(b.team_id || '-').padStart(5)} ${String(b.active_roster || 0).padStart(6)} ${String(b.current_league_id || '-').padStart(7)}`);
    }
  });

bots
  .command('seed')
  .description('Ensure at least N bots exist with fresh rosters')
  .requiredOption('-c, --count <n>', 'target bot count', (v) => parseInt(v, 10))
  .action((opts) => {
    const db = getDb();
    const before = listBots(db).length;
    const all = seedBots(db, opts.count);
    console.log(`Bots: ${before} → ${all.length} (target ${opts.count}).`);
  });

bots
  .command('retire-all')
  .description('Retire every bot roster (release masters back to pool)')
  .action(() => {
    const db = getDb();
    const n = retireAllBotRosters(db);
    console.log(`Retired ${n} bot fighter(s); masters returned to unclaimed pool.`);
  });

// --- Market ---

const market = program.command('market').description('Unclaimed master-roster listings');

market
  .command('list')
  .description('Show unclaimed masters available for signup/purchase')
  .option('-n, --limit <n>', 'max rows', (v) => parseInt(v, 10), 40)
  .action((opts) => {
    const db = getDb();
    const rows = marketListings(db, { limit: opts.limit });
    if (rows.length === 0) { console.log('Market is empty.'); return; }
    console.log(`\n${'#'.padStart(5)} ${'File'.padEnd(26)} ${'Display'.padEnd(24)} ${'Author'.padEnd(16)} ${'Wins'.padStart(5)} ${'Price'.padStart(7)}`);
    console.log('-'.repeat(95));
    for (const r of rows) {
      const fname = (r.file_name || '').slice(0, 26);
      const display = (r.display_name || '').slice(0, 24);
      const author = (r.author || '').slice(0, 16);
      console.log(`${String(r.id).padStart(5)} ${fname.padEnd(26)} ${display.padEnd(24)} ${author.padEnd(16)} ${String(r.matches_won).padStart(5)} ${String(r.price_cents).padStart(7)}`);
    }
    console.log(`\nShowing ${rows.length} of unlimited.  (Total unclaimed available in DB shows above.)`);
  });

program.hook('postAction', () => {
  closeDb();
});

program.parse();
