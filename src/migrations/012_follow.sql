-- Follow list: a user can star a master fighter (so it surfaces to the top
-- of the market if listed) or a team (so its name is highlighted wherever
-- it appears). Polymorphic table — kind picks which thing target_id refers
-- to. UNIQUE(user_id, target_kind, target_id) so a star toggles cleanly.
CREATE TABLE user_follow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('master', 'team')),
  target_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, target_kind, target_id)
);
CREATE INDEX idx_user_follow_user ON user_follow(user_id);
CREATE INDEX idx_user_follow_target ON user_follow(target_kind, target_id);
