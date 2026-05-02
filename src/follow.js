/**
 * Follow list — a lightweight "favorites" mechanism.
 *
 * A user can follow:
 *   - master fighters (by fighter.id) → so they surface to the top of the
 *     market the moment someone lists them.
 *   - teams (by team.id) → so the team's name renders highlighted wherever
 *     it appears (sidebar, schedule, side-card, etc).
 *
 * Polymorphic table user_follow(user_id, target_kind, target_id) with
 * UNIQUE(user_id, target_kind, target_id) so the star is a clean toggle.
 */

const KINDS = new Set(['master', 'team']);

export function isFollowing(db, userId, kind, id) {
  if (!KINDS.has(kind)) return false;
  const r = db.prepare(
    'SELECT 1 FROM user_follow WHERE user_id = ? AND target_kind = ? AND target_id = ?'
  ).get(userId, kind, id);
  return !!r;
}

export function follow(db, userId, kind, id) {
  if (!KINDS.has(kind)) return { ok: false, error: 'bad_kind' };
  db.prepare(
    'INSERT OR IGNORE INTO user_follow (user_id, target_kind, target_id) VALUES (?, ?, ?)'
  ).run(userId, kind, id);
  return { ok: true };
}

export function unfollow(db, userId, kind, id) {
  if (!KINDS.has(kind)) return { ok: false, error: 'bad_kind' };
  db.prepare(
    'DELETE FROM user_follow WHERE user_id = ? AND target_kind = ? AND target_id = ?'
  ).run(userId, kind, id);
  return { ok: true };
}

/**
 * Return { masters: Set<id>, teams: Set<id> } for the user — handy for the
 * client to keep around so every team-name render can check membership in
 * O(1) without a round trip per row.
 */
export function listFollows(db, userId) {
  const rows = db.prepare(
    'SELECT target_kind, target_id FROM user_follow WHERE user_id = ?'
  ).all(userId);
  const masters = [];
  const teams = [];
  for (const r of rows) {
    if (r.target_kind === 'master') masters.push(r.target_id);
    else if (r.target_kind === 'team') teams.push(r.target_id);
  }
  return { masters, teams };
}
