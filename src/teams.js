/**
 * Team management: signup bootstrapping, roster queries, lineup rules.
 *
 * Invariants:
 *  - One team per user (team.UNIQUE(user_id)).
 *  - Active slot count = 5 exactly for league-eligible teams. 0..5 bench, 0..n for_sale
 *    (but for_sale implies the fighter was benched first — moving to for_sale
 *    must leave active at 5, enforced at listing time).
 *  - Master fighters (fighter.is_master=1) are never modified; user changes
 *    live on owned_fighter / owned_fighter_ai.
 */

import { getDb } from './db.js';
import {
  readEffectiveStamina,
  LOW_STAMINA_ROTATION_THRESHOLD,
} from './stamina.js';
import { drawStarterMasters, listUnclaimedOldest, getKfmId, maxBenchSizeForUser } from './market.js';

const FULL_ACTIVE_ROSTER = 5;

const STARTER_UNCLAIMED_COUNT = 4;
const STARTER_TOTAL = 5;

/**
 * Create a team for the user and populate 5 starter fighters.
 *   - 4 slots drawn from unclaimed 0-win masters (KFM padding if pool dry).
 *   - 1 KFM training-dummy slot (non-unique, always available).
 * Display names default to the master's display_name; KFM slot is labelled
 * "Training Dummy" to distinguish it in the lineup.
 */
export function bootstrapTeamForUser(db, userId, teamName) {
  const existing = db.prepare('SELECT id FROM team WHERE user_id = ?').get(userId);
  if (existing) return existing.id;

  const insertTeam = db.prepare(
    'INSERT INTO team (user_id, name, rotation_threshold) VALUES (?, ?, 0.85)'
  );
  const insertFighter = db.prepare(
    'INSERT INTO owned_fighter (team_id, master_fighter_id, display_name, slot, priority) VALUES (?, ?, ?, \'active\', ?)'
  );
  const insertHistory = db.prepare(
    'INSERT INTO owned_fighter_team_history (owned_fighter_id, team_id, reason) VALUES (?, ?, ?)'
  );

  const txn = db.transaction(() => {
    const teamId = insertTeam.run(userId, teamName).lastInsertRowid;
    const masters = drawStarterMasters(db, STARTER_UNCLAIMED_COUNT);
    const kfmId = getKfmId(db);

    for (let i = 0; i < STARTER_UNCLAIMED_COUNT; i++) {
      const m = masters[i];
      const name = m.display_name || m.file_name;
      const fId = insertFighter.run(teamId, m.id, name, i).lastInsertRowid;
      insertHistory.run(fId, teamId, 'created');
    }
    const dummyId = insertFighter.run(teamId, kfmId, 'Training Dummy', STARTER_TOTAL - 1).lastInsertRowid;
    insertHistory.run(dummyId, teamId, 'created');
    return teamId;
  });
  return txn();
}

export function getTeamForUser(db, userId) {
  const team = db.prepare('SELECT * FROM team WHERE user_id = ?').get(userId);
  if (!team) return null;
  const fighters = db
    .prepare(`
      SELECT of.*, f.file_name AS master_file_name, f.display_name AS master_display_name,
        f.author AS master_author
      FROM owned_fighter of
      JOIN fighter f ON of.master_fighter_id = f.id
      WHERE of.team_id = ? AND of.is_retired = 0
      ORDER BY of.slot, of.priority, of.id
    `)
    .all(team.id);
  return { ...team, fighters };
}

/**
 * Rewrite a team's lineup. Enforces: exactly 5 active, 0..5 bench, at most 1
 * for_sale (stays as-is if present), priority numbers distinct within active,
 * and every id belongs to the team.
 *
 * Body: { active: [id*5], bench: [id*0..5], priority: {id: n}, auto_rotate: bool }
 * Anything in slot='for_sale' stays in place; the caller doesn't mention those.
 */
export function setLineup(db, teamId, body) {
  const active = Array.isArray(body.active) ? body.active.map(Number) : [];
  const bench = Array.isArray(body.bench) ? body.bench.map(Number) : [];
  const priority = body.priority && typeof body.priority === 'object' ? body.priority : {};
  // All rotation fields are conditional: `undefined` means the caller isn't
  // touching that field, so we leave the existing column value alone. The
  // /lineup PUT is shared between the rotation-rules form (sends everything)
  // and lineup edits like drag-reorder (sends only what changed). Earlier we
  // had `body.rotate_on_stamina ? 1 : 0`, which silently wiped the flag any
  // time a lineup edit didn't include it.
  const autoRotate     = body.auto_rotate        === undefined ? null : (body.auto_rotate ? 1 : 0);
  const rotateOnStamina = body.rotate_on_stamina === undefined ? null : (body.rotate_on_stamina ? 1 : 0);
  const rotateOnLosses  = body.rotate_on_losses  === undefined ? null : (body.rotate_on_losses ? 1 : 0);
  const VALID_MODES = ['fixed', 'stamina', 'losses', 'sequential_active', 'sequential_full'];
  let rotationMode = body.rotation_mode === undefined ? null : String(body.rotation_mode);
  if (rotationMode != null && !VALID_MODES.includes(rotationMode)) {
    return { status: 400, body: { error: 'rotation_mode must be one of: ' + VALID_MODES.join(', ') } };
  }
  let rotationThreshold = body.rotation_threshold;
  if (rotationThreshold != null) {
    rotationThreshold = Number(rotationThreshold);
    if (!Number.isFinite(rotationThreshold) || rotationThreshold < 0 || rotationThreshold > 1) {
      return { status: 400, body: { error: 'rotation_threshold must be between 0.0 and 1.0' } };
    }
  }
  let rotationLossStreak = body.rotation_loss_streak;
  if (rotationLossStreak != null) {
    rotationLossStreak = Math.floor(Number(rotationLossStreak));
    if (!Number.isFinite(rotationLossStreak) || rotationLossStreak < 1 || rotationLossStreak > 99) {
      return { status: 400, body: { error: 'rotation_loss_streak must be 1..99' } };
    }
  }

  if (active.length !== 5) {
    return { status: 400, body: { error: 'Lineup must have exactly 5 active fighters' } };
  }
  const team = db.prepare('SELECT user_id FROM team WHERE id = ?').get(teamId);
  const benchCap = team ? maxBenchSizeForUser(db, team.user_id) : 5;
  if (bench.length > benchCap) {
    return { status: 400, body: { error: 'At most ' + benchCap + ' bench fighters allowed' } };
  }
  if (new Set([...active, ...bench]).size !== active.length + bench.length) {
    return { status: 400, body: { error: 'Duplicate IDs across active/bench' } };
  }

  const teamFighters = db
    .prepare('SELECT id, slot FROM owned_fighter WHERE team_id = ?')
    .all(teamId);
  const byId = new Map(teamFighters.map((f) => [f.id, f]));

  const referenced = [...active, ...bench];
  for (const id of referenced) {
    const f = byId.get(id);
    if (!f) return { status: 400, body: { error: `Fighter ${id} isn't on this team` } };
    if (f.slot === 'for_sale') {
      return { status: 400, body: { error: `Fighter ${id} is listed for sale and can't be assigned` } };
    }
  }

  const tx = db.transaction(() => {
    const cols = [];
    const args = [];
    if (autoRotate != null)        { cols.push('auto_rotate = ?');         args.push(autoRotate); }
    if (rotateOnStamina != null)   { cols.push('rotate_on_stamina = ?');   args.push(rotateOnStamina); }
    if (rotateOnLosses != null)    { cols.push('rotate_on_losses = ?');    args.push(rotateOnLosses); }
    if (rotationThreshold != null) { cols.push('rotation_threshold = ?');  args.push(rotationThreshold); }
    if (rotationLossStreak != null){ cols.push('rotation_loss_streak = ?');args.push(rotationLossStreak); }
    if (rotationMode != null)      { cols.push('rotation_mode = ?');       args.push(rotationMode); }
    if (cols.length) {
      args.push(teamId);
      db.prepare(`UPDATE team SET ${cols.join(', ')} WHERE id = ?`).run(...args);
    }
    const setActive = db.prepare(
      "UPDATE owned_fighter SET slot = 'active', priority = ? WHERE id = ? AND team_id = ?"
    );
    const setBench = db.prepare(
      "UPDATE owned_fighter SET slot = 'bench' WHERE id = ? AND team_id = ?"
    );
    active.forEach((id, idx) => setActive.run(priority[id] ?? idx, id, teamId));
    bench.forEach((id) => setBench.run(id, teamId));
  });
  tx();

  return { status: 200, body: { ok: true } };
}

/**
 * Pick 5 fighters to field for a fixture. Starts from active roster ordered by
 * priority; if the team has auto_rotate=1, swap any active fighter whose
 * effective stamina is below the threshold for a bench fighter whose stamina
 * is above it, preferring the highest-stamina bench fighter.
 *
 * Returns null if the team can't field 5 eligible fighters.
 */
/**
 * Choose ONE active fighter to field for the next fixture. Two independent
 * triggers, either may fire a rotation:
 *   rotate_on_stamina — skip if stamina < rotation_threshold
 *   rotate_on_losses  — skip if consecutive_losses ≥ rotation_loss_streak
 *
 * Walks priorities; picks the first fighter where every ENABLED trigger
 * says "keep". All rejected → falls back to priority 0 (team plays anyway;
 * no forfeit on fatigue).
 *
 * Bench fighters are never auto-selected. Returns null if 0 active.
 */
export function pickActiveFighter(db, teamId) {
  const team = db.prepare(
    `SELECT t.auto_rotate, t.rotate_on_stamina, t.rotate_on_losses,
            t.rotation_threshold, t.rotation_loss_streak, t.rotation_mode, u.is_bot
       FROM team t JOIN user_account u ON u.id = t.user_id
      WHERE t.id = ?`
  ).get(teamId);
  if (!team) return null;
  const actives = db
    .prepare("SELECT * FROM owned_fighter WHERE team_id = ? AND is_retired = 0 AND slot = 'active' ORDER BY priority, id")
    .all(teamId);
  if (actives.length === 0) return null;

  // Helper: sequential rotation index = count of completed fixtures the team
  // has played. Deterministic; resumes correctly across server restarts.
  const rotationIndex = () => db.prepare(
    "SELECT COUNT(*) AS n FROM fixture WHERE (home_team_id = ? OR away_team_id = ?) AND status = 'complete'"
  ).get(teamId, teamId).n;

  // 'sequential_active' mode: cycle through 5 actives in priority order,
  // ignoring stamina + loss-streak rules. Same logic bots use.
  if (team.rotation_mode === 'sequential_active') {
    return actives[rotationIndex() % actives.length];
  }

  // 'sequential_full' mode: cycle through active + bench (up to 10) in
  // (slot, priority, id) order. When the rotation lands on a benched
  // fighter, promote them to active and demote the highest-priority
  // active fighter to bench in the same transaction — so the team always
  // has exactly 5 active and the lineup view stays consistent.
  if (team.rotation_mode === 'sequential_full') {
    const all = db.prepare(
      `SELECT * FROM owned_fighter
       WHERE team_id = ? AND is_retired = 0 AND slot IN ('active', 'bench')
       ORDER BY (CASE slot WHEN 'active' THEN 0 ELSE 1 END), priority, id`
    ).all(teamId);
    if (all.length === 0) return actives[0];
    const picked = all[rotationIndex() % all.length];
    if (picked.slot === 'bench') {
      // Demote the bottom-priority active (the one that's been up longest;
      // first in the rotation order, which gets cycled the most). The
      // benched fighter inherits its priority slot and is fielded now.
      const demote = actives[actives.length - 1];
      const swap = db.transaction(() => {
        db.prepare("UPDATE owned_fighter SET slot = 'active', priority = ? WHERE id = ?")
          .run(demote.priority, picked.id);
        db.prepare("UPDATE owned_fighter SET slot = 'bench', priority = ? WHERE id = ?")
          .run(picked.priority, demote.id);
      });
      swap();
      picked.slot = 'active';
      picked.priority = demote.priority;
    }
    return picked;
  }

  // Bots: same as 'sequential_active' — strict sequential rotation. Every
  // fighter gets equal screen time regardless of stamina or loss streak.
  if (team.is_bot) {
    return actives[rotationIndex() % actives.length];
  }

  const autoOn = !!team.auto_rotate;
  const stamOn = autoOn && !!team.rotate_on_stamina;
  const lossOn = autoOn && !!team.rotate_on_losses;
  if (!stamOn && !lossOn) return actives[0];

  const threshold = team.rotation_threshold != null ? team.rotation_threshold : LOW_STAMINA_ROTATION_THRESHOLD;
  const cap = team.rotation_loss_streak || 3;

  for (const f of actives) {
    const eff = readEffectiveStamina(db, f.id);
    const staminaOk = !stamOn || eff >= threshold;
    const lossOk = !lossOn || (f.consecutive_losses || 0) < cap;
    if (staminaOk && lossOk) return { ...f, eff };
  }
  return actives[0];
}

/**
 * Does the team have the minimum roster to play (>= 1 active, non-retired)?
 * Used by the fixture runner before launching a match.
 */
export function teamCanPlay(db, teamId) {
  const { n } = db.prepare(
    "SELECT COUNT(*) AS n FROM owned_fighter WHERE team_id = ? AND is_retired = 0 AND slot = 'active'"
  ).get(teamId);
  return n >= 1;
}

/**
 * If the team's active roster has fallen below FULL_ACTIVE_ROSTER (5), top
 * it up from the oldest unclaimed masters in the pool. Falls back to KFM
 * if the pool is empty so the team always reaches 5 active.
 *
 * Why oldest first: the user wants predictable draining of the unclaimed
 * pool, not random. Old masters have been sitting unclaimed longest so
 * they're the right candidates to bring back into rotation.
 *
 * Logs every replenish as a `team_notice` row (kind='auto_replenish') so
 * the next time the user visits /team they're told their team got new
 * fighters. Returns the count added.
 */
export function topUpRoster(db, teamId, target = FULL_ACTIVE_ROSTER) {
  const have = db.prepare(
    "SELECT COUNT(*) AS n FROM owned_fighter WHERE team_id = ? AND is_retired = 0 AND slot = 'active'"
  ).get(teamId).n;
  const need = target - have;
  if (need <= 0) return { added: 0, fighters: [] };

  const masters = listUnclaimedOldest(db, { limit: need });
  const kfmId = getKfmId(db);
  const kfmRow = db.prepare('SELECT id, file_name, display_name FROM fighter WHERE id = ?').get(kfmId);
  while (masters.length < need) masters.push(kfmRow);

  const insertFighter = db.prepare(
    "INSERT INTO owned_fighter (team_id, master_fighter_id, display_name, slot, priority) VALUES (?, ?, ?, 'active', ?)"
  );
  const resurrectFighter = db.prepare(
    "UPDATE owned_fighter SET team_id = ?, slot = 'active', priority = ?, is_retired = 0, listing_price_cents = NULL, display_name = ? WHERE id = ?"
  );
  // Only resurrect for unique masters. Non-unique (KFM training dummies,
  // future bulk-spawn types) always get fresh INSERTs so duplicates are
  // possible and each instance has its own per-team stats.
  const findRetiredClone = db.prepare(
    `SELECT o.id FROM owned_fighter o
     JOIN fighter f ON f.id = o.master_fighter_id
     WHERE o.master_fighter_id = ? AND o.is_retired = 1 AND f.is_unique = 1
     ORDER BY o.id DESC LIMIT 1`
  );
  const insertHistory = db.prepare(
    "INSERT INTO owned_fighter_team_history (owned_fighter_id, team_id, reason) VALUES (?, ?, ?)"
  );
  const insertNotice = db.prepare(
    "INSERT INTO team_notice (team_id, kind, body) VALUES (?, 'auto_replenish', ?)"
  );

  const tx = db.transaction(() => {
    const maxPrio = db.prepare(
      "SELECT COALESCE(MAX(priority), -1) AS p FROM owned_fighter WHERE team_id = ? AND slot = 'active'"
    ).get(teamId).p;
    const added = [];
    let prio = maxPrio + 1;
    for (const m of masters) {
      const isKfm = m.id === kfmId;
      const name = isKfm ? 'Training Dummy' : (m.display_name || m.file_name);
      // Resurrect a retired clone if one exists for this master — preserves
      // per-team W/L/D record across release-and-rebuy cycles. KFM is
      // non-unique training-dummy padding; never resurrect, always insert.
      let fId;
      const retired = isKfm ? null : findRetiredClone.get(m.id);
      if (retired) {
        resurrectFighter.run(teamId, prio, name, retired.id);
        fId = retired.id;
      } else {
        fId = insertFighter.run(teamId, m.id, name, prio).lastInsertRowid;
      }
      prio++;
      insertHistory.run(fId, teamId, 'auto_replenish');
      added.push({
        owned_fighter_id: fId,
        display_name: name,
        master_file_name: m.file_name,
        master_display_name: m.display_name,
      });
    }
    insertNotice.run(teamId, JSON.stringify({ added }));
    return added;
  });
  const added = tx();
  return { added: added.length, fighters: added };
}

/**
 * Pending team_notice rows for the user's team. Returned by /api/me/team
 * so the frontend can show a banner explaining auto-replenish events.
 */
export function listOpenNotices(db, teamId) {
  return db.prepare(
    "SELECT id, kind, body, created_at FROM team_notice WHERE team_id = ? AND dismissed_at IS NULL ORDER BY id DESC"
  ).all(teamId).map((n) => ({
    ...n,
    body: n.body ? JSON.parse(n.body) : null,
  }));
}

export function dismissNotice(db, teamId, noticeId) {
  const r = db.prepare(
    "UPDATE team_notice SET dismissed_at = datetime('now') WHERE id = ? AND team_id = ? AND dismissed_at IS NULL"
  ).run(noticeId, teamId);
  return { ok: r.changes > 0 };
}

export function getTeamById(db, teamId) {
  const team = db.prepare('SELECT * FROM team WHERE id = ?').get(teamId);
  if (!team) return null;
  const fighters = db
    .prepare(`
      SELECT of.*, f.file_name AS master_file_name, f.display_name AS master_display_name,
        f.author AS master_author
      FROM owned_fighter of
      JOIN fighter f ON of.master_fighter_id = f.id
      WHERE of.team_id = ? AND of.is_retired = 0
      ORDER BY of.slot, of.priority, of.id
    `)
    .all(teamId);
  return { ...team, fighters };
}
