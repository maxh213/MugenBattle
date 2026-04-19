-- Platform v2 M5: leagues, divisions, fixtures.
-- A league is one season. Divisions are tiers inside a league (tier 1 = top).
-- Teams in the same division play a round-robin (configurable legs).
-- Each fixture = 5 head-to-head matches (slot-by-slot between the two lineups).

CREATE TABLE league (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete')),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE division (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL REFERENCES league(id),
  tier INTEGER NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (league_id, tier)
);
CREATE INDEX idx_division_league ON division(league_id);

-- Team participation in a division. Standings are materialised here and
-- recomputed incrementally as fixtures complete.
CREATE TABLE division_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id INTEGER NOT NULL REFERENCES division(id),
  team_id INTEGER NOT NULL REFERENCES team(id),
  points INTEGER NOT NULL DEFAULT 0,
  fixtures_played INTEGER NOT NULL DEFAULT 0,
  fixtures_won INTEGER NOT NULL DEFAULT 0,
  fixtures_drawn INTEGER NOT NULL DEFAULT 0,
  fixtures_lost INTEGER NOT NULL DEFAULT 0,
  matches_won INTEGER NOT NULL DEFAULT 0,
  matches_lost INTEGER NOT NULL DEFAULT 0,
  UNIQUE (division_id, team_id)
);
CREATE INDEX idx_division_team_division ON division_team(division_id);

CREATE TABLE fixture (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id INTEGER NOT NULL REFERENCES division(id),
  round_num INTEGER NOT NULL,
  slot_num INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES team(id),
  away_team_id INTEGER NOT NULL REFERENCES team(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete')),
  home_score INTEGER,
  away_score INTEGER,
  winner_team_id INTEGER REFERENCES team(id),
  stage_id INTEGER REFERENCES stage(id),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_fixture_division ON fixture(division_id);
CREATE INDEX idx_fixture_status ON fixture(status);

-- Each slot of a fixture (5 per fixture).
CREATE TABLE fixture_match (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id INTEGER NOT NULL REFERENCES fixture(id),
  slot INTEGER NOT NULL,
  home_owned_fighter_id INTEGER NOT NULL REFERENCES owned_fighter(id),
  away_owned_fighter_id INTEGER NOT NULL REFERENCES owned_fighter(id),
  stage_id INTEGER NOT NULL REFERENCES stage(id),
  home_rounds INTEGER NOT NULL DEFAULT 0,
  away_rounds INTEGER NOT NULL DEFAULT 0,
  winner TEXT NOT NULL CHECK (winner IN ('home', 'away', 'draw')),
  played_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (fixture_id, slot)
);
CREATE INDEX idx_fixture_match_fixture ON fixture_match(fixture_id);
