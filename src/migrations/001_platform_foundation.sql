-- Platform v2: users become first-class owners of teams + fighters.
-- Extends existing user_account (we don't use passwords — signed-cookie email auth lives in src/auth.js).
-- Extends fighter to flag master-pool rows (everything scraped to date).
-- Introduces team, owned_fighter, ai overrides, wallet ledger, team history.

-- --- user_account extensions ---
-- (SQLite can't ADD COLUMN inside a single multi-statement block cleanly if
-- the column exists; migrations runner tracks applied set, so this only runs once.)
ALTER TABLE user_account ADD COLUMN balance_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_account ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_account ADD COLUMN banned_reason TEXT;

-- --- fighter: mark all existing rows as master pool ---
ALTER TABLE fighter ADD COLUMN is_master INTEGER NOT NULL DEFAULT 1;

-- --- team ---
CREATE TABLE team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user_account(id),
  name TEXT NOT NULL,
  auto_rotate INTEGER NOT NULL DEFAULT 1,
  current_league_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id)
);

-- --- owned_fighter ---
CREATE TABLE owned_fighter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES team(id),
  master_fighter_id INTEGER NOT NULL REFERENCES fighter(id),
  display_name TEXT NOT NULL,
  stamina REAL NOT NULL DEFAULT 1.0,
  stamina_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  slot TEXT NOT NULL DEFAULT 'active'
    CHECK (slot IN ('active', 'bench', 'for_sale')),
  priority INTEGER NOT NULL DEFAULT 0,
  is_imported INTEGER NOT NULL DEFAULT 0,
  import_status TEXT
    CHECK (import_status IS NULL OR import_status IN ('pending', 'approved', 'rejected')),
  import_reject_reason TEXT,
  import_test_log TEXT,
  matches_won INTEGER NOT NULL DEFAULT 0,
  matches_lost INTEGER NOT NULL DEFAULT 0,
  matches_drawn INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_owned_fighter_team ON owned_fighter(team_id);
CREATE INDEX idx_owned_fighter_master ON owned_fighter(master_fighter_id);

-- --- AI override versions ---
-- Applied AI = row with MAX(version) for a given owned_fighter_id.
-- No rows = use the master .cmd as-is.
CREATE TABLE owned_fighter_ai (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owned_fighter_id INTEGER NOT NULL REFERENCES owned_fighter(id),
  cmd_text TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owned_fighter_id, version)
);

-- --- Wallet ledger ---
-- user_account.balance_cents is a materialised sum. Ledger is the truth.
CREATE TABLE wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user_account(id),
  delta_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_wallet_ledger_user ON wallet_ledger(user_id);

-- --- Team history (for transfers / audit) ---
CREATE TABLE owned_fighter_team_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owned_fighter_id INTEGER NOT NULL REFERENCES owned_fighter(id),
  team_id INTEGER NOT NULL REFERENCES team(id),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  left_at TEXT,
  reason TEXT
);
CREATE INDEX idx_owned_fighter_history_f ON owned_fighter_team_history(owned_fighter_id);
