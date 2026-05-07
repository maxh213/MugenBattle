-- Widen the team.rotation_mode CHECK constraint to allow two new sequential
-- modes that override the conditional stamina/loss-streak rules:
--   - 'sequential_active' : cycle through 5 active fighters, ignoring stamina/losses
--   - 'sequential_full'   : cycle through active + bench (up to 10), same override
--
-- SQLite can't ALTER a CHECK constraint in place. Standard 12-step recipe:
-- create new table, copy data, drop old, rename. defer_foreign_keys lets
-- us do this inside the runner's transaction (PRAGMA foreign_keys = OFF
-- silently no-ops when wrapped in BEGIN).

PRAGMA defer_foreign_keys = ON;

CREATE TABLE team_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user_account(id),
  name TEXT NOT NULL,
  auto_rotate INTEGER NOT NULL DEFAULT 1,
  current_league_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rotation_threshold REAL NOT NULL DEFAULT 0.30,
  rotation_mode TEXT NOT NULL DEFAULT 'stamina'
    CHECK (rotation_mode IN ('fixed', 'stamina', 'losses', 'sequential_active', 'sequential_full')),
  rotation_loss_streak INTEGER NOT NULL DEFAULT 3,
  rotate_on_stamina INTEGER NOT NULL DEFAULT 1,
  rotate_on_losses INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id)
);

INSERT INTO team_new
  (id, user_id, name, auto_rotate, current_league_id, created_at,
   rotation_threshold, rotation_mode, rotation_loss_streak,
   rotate_on_stamina, rotate_on_losses)
SELECT id, user_id, name, auto_rotate, current_league_id, created_at,
   rotation_threshold, rotation_mode, rotation_loss_streak,
   rotate_on_stamina, rotate_on_losses
FROM team;

DROP TABLE team;
ALTER TABLE team_new RENAME TO team;
