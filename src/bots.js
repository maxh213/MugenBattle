/**
 * Bot players. They fill empty league slots so seasons always run with a full
 * bracket regardless of real-user count. Bots follow the same lineup/match
 * rules as real users — the runner doesn't distinguish. What's different:
 *   - user_account.is_bot = 1
 *   - Rosters regenerate fresh at each season start and retire at season end,
 *     so their unique masters flow back to the pool for new signups.
 */

import { drawStarterMasters, getKfmId } from './market.js';

const BOT_EMAIL_DOMAIN = 'system.local';
const STARTER_UNCLAIMED_COUNT = 4;
const STARTER_TOTAL = 5;

function padNum(n) {
  return String(n).padStart(3, '0');
}

function insertStarterRoster(db, teamId) {
  const insertFighter = db.prepare(
    "INSERT INTO owned_fighter (team_id, master_fighter_id, display_name, slot, priority) VALUES (?, ?, ?, 'active', ?)"
  );
  const insertHistory = db.prepare(
    'INSERT INTO owned_fighter_team_history (owned_fighter_id, team_id, reason) VALUES (?, ?, ?)'
  );
  const masters = drawStarterMasters(db, STARTER_UNCLAIMED_COUNT);
  const kfmId = getKfmId(db);
  for (let i = 0; i < STARTER_UNCLAIMED_COUNT; i++) {
    const m = masters[i];
    const name = m.display_name || m.file_name;
    const fId = insertFighter.run(teamId, m.id, name, i).lastInsertRowid;
    insertHistory.run(fId, teamId, 'created');
  }
  const dId = insertFighter.run(teamId, kfmId, 'Training Dummy', STARTER_TOTAL - 1).lastInsertRowid;
  insertHistory.run(dId, teamId, 'created');
}

/**
 * Ensure at least `total` bot users exist, each with a team + full active
 * roster. Missing bots are created; existing bots whose roster was retired
 * (e.g. between seasons) get a fresh draw. Returns the full bot-team list.
 */
export function seedBots(db, total) {
  const insertUser = db.prepare(
    "INSERT INTO user_account (email, username, is_bot) VALUES (?, ?, 1)"
  );
  const insertTeam = db.prepare(
    'INSERT INTO team (user_id, name, rotation_threshold) VALUES (?, ?, 0.85)'
  );

  const tx = db.transaction(() => {
    const have = db.prepare('SELECT COUNT(*) AS n FROM user_account WHERE is_bot = 1').get().n;
    let idx = 1;
    let created = 0;
    while (have + created < total) {
      let username;
      for (;;) {
        username = `bot_${padNum(idx)}`;
        const clash = db.prepare('SELECT id FROM user_account WHERE lower(username) = lower(?)').get(username);
        if (!clash) break;
        idx++;
      }
      const email = `${username}@${BOT_EMAIL_DOMAIN}`;
      const userId = insertUser.run(email, username).lastInsertRowid;
      const teamId = insertTeam.run(userId, `${username}'s Team`).lastInsertRowid;
      insertStarterRoster(db, teamId);
      created++;
      idx++;
    }

    // Refill any existing bot whose roster is short (fewer than 5 active
    // non-retired fighters). Happens after retireAllBotRosters.
    const shorts = db.prepare(`
      SELECT t.id FROM team t
      JOIN user_account u ON t.user_id = u.id
      WHERE u.is_bot = 1
        AND (SELECT COUNT(*) FROM owned_fighter WHERE team_id = t.id AND is_retired = 0 AND slot = 'active') < 5
    `).all();
    for (const { id: teamId } of shorts) {
      insertStarterRoster(db, teamId);
    }
  });
  tx();

  return db.prepare(`
    SELECT u.id AS user_id, u.username, t.id AS team_id
    FROM user_account u
    JOIN team t ON t.user_id = u.id
    WHERE u.is_bot = 1
    ORDER BY u.id
  `).all();
}

/**
 * Retire every non-retired owned_fighter on bot teams, releasing their
 * unique masters back to the pool. Also clears current_league_id on those
 * teams so they're ready to be re-rostered for the next season.
 */
export function retireAllBotRosters(db) {
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      UPDATE owned_fighter SET is_retired = 1
      WHERE team_id IN (
        SELECT t.id FROM team t JOIN user_account u ON t.user_id = u.id WHERE u.is_bot = 1
      ) AND is_retired = 0
    `).run();
    db.prepare(`
      UPDATE team SET current_league_id = NULL
      WHERE id IN (
        SELECT t.id FROM team t JOIN user_account u ON t.user_id = u.id WHERE u.is_bot = 1
      )
    `).run();
    return rows.changes;
  });
  return tx();
}

export function listBots(db) {
  return db.prepare(`
    SELECT u.id AS user_id, u.username, t.id AS team_id,
      (SELECT COUNT(*) FROM owned_fighter WHERE team_id = t.id AND is_retired = 0 AND slot = 'active') AS active_roster,
      t.current_league_id
    FROM user_account u
    LEFT JOIN team t ON t.user_id = u.id
    WHERE u.is_bot = 1
    ORDER BY u.id
  `).all();
}
