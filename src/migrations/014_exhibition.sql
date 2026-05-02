-- Exhibition matches: ad-hoc one-off matches between two owned_fighters.
-- Run on dedicated exhibition workers (not league workers). Stat updates
-- (W/L/D, stamina, master record) apply to both fighters; no league
-- standings or fixtures are touched.

CREATE TABLE exhibition_match (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  home_owned_fighter_id INTEGER NOT NULL REFERENCES owned_fighter(id),
  away_owned_fighter_id INTEGER NOT NULL REFERENCES owned_fighter(id),
  stage_id INTEGER REFERENCES stage(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  winner_owned_fighter_id INTEGER REFERENCES owned_fighter(id),
  -- 'fighter1' / 'fighter2' / 'draw' from parseIkemenResult, kept verbatim
  -- so the UI doesn't need to derive draw vs winner from null.
  result TEXT,
  worker_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX idx_exhibition_status_id ON exhibition_match(status, id);
CREATE INDEX idx_exhibition_user ON exhibition_match(requester_user_id, id DESC);
