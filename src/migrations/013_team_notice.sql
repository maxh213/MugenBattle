-- Team notices — surfaces system-driven roster changes back to the user on
-- their next /team visit. First use case: auto-replenish when a team's roster
-- drops below the full size and we hand them oldest unclaimed masters.
-- Could also carry retirement / deactivation explanations later.
CREATE TABLE team_notice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,           -- 'auto_replenish'
  body TEXT,                    -- JSON detail; for auto_replenish: { added: [{name, master_file_name}] }
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed_at TEXT
);
CREATE INDEX idx_team_notice_team ON team_notice(team_id);
CREATE INDEX idx_team_notice_open ON team_notice(team_id, dismissed_at);
