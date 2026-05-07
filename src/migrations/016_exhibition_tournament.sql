-- Exhibition tournaments: single-elimination brackets of owned_fighters,
-- queued from the /exhibition page. Same stat rules as exhibitions (W/L/D
-- + master record update, no stamina drain, full life both sides). Runs on
-- exhibition workers in a future slice; for now this just persists the
-- bracket so the runner has something to consume.

CREATE TABLE exhibition_tournament (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  size INTEGER NOT NULL CHECK (size IN (4, 8, 16, 32, 64)),
  rounds_per_fight INTEGER NOT NULL DEFAULT 1 CHECK (rounds_per_fight IN (1, 3, 5)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
  winner_owned_fighter_id INTEGER REFERENCES owned_fighter(id),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

-- Pre-create one row per match for every round at tournament creation time
-- so the bracket structure is always complete; later rounds start with
-- null home/away and get populated as predecessors finish.
CREATE TABLE exhibition_tournament_match (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES exhibition_tournament(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  match_index INTEGER NOT NULL,
  home_owned_fighter_id INTEGER REFERENCES owned_fighter(id),
  away_owned_fighter_id INTEGER REFERENCES owned_fighter(id),
  winner_owned_fighter_id INTEGER REFERENCES owned_fighter(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  worker_id INTEGER,
  result TEXT,
  error TEXT,
  stage_id INTEGER REFERENCES stage(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(tournament_id, round, match_index)
);

CREATE INDEX idx_extourn_status ON exhibition_tournament(status, id);
CREATE INDEX idx_extourn_user ON exhibition_tournament(requester_user_id, id DESC);
CREATE INDEX idx_extournm_tourn ON exhibition_tournament_match(tournament_id, round, match_index);
CREATE INDEX idx_extournm_status ON exhibition_tournament_match(status, id);
