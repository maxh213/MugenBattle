-- User character uploads. Each row tracks one attempted import through the
-- pipeline (extract → validate → sandbox test → install). Keeps failed
-- attempts around so users can see WHY their upload was rejected.

CREATE TABLE character_import (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user_account(id),
  original_filename TEXT,
  size_bytes INTEGER,
  sha256 TEXT,                     -- dedup: reject if a prior approved import matches
  file_name TEXT,                  -- the char dir name that got installed (or attempted)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'extracting', 'validating', 'testing', 'approved', 'rejected')),
  reject_reason TEXT,
  test_log TEXT,                   -- excerpt of Ikemen's sandbox-test log on failure
  fighter_id INTEGER REFERENCES fighter(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX idx_character_import_user ON character_import(user_id);
CREATE INDEX idx_character_import_status ON character_import(status);

-- Who uploaded an imported char. NULL for scraped / bundled masters.
ALTER TABLE fighter ADD COLUMN imported_by_user_id INTEGER REFERENCES user_account(id);
