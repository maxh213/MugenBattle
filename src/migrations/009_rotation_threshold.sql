-- Per-team rotation knob. When team.auto_rotate is on, selectLineup swaps
-- any active fighter whose effective stamina is below this threshold for
-- the rested bench fighter with the highest stamina. Default matches the
-- previous hardcoded LOW_STAMINA_ROTATION_THRESHOLD of 0.30.

ALTER TABLE team ADD COLUMN rotation_threshold REAL NOT NULL DEFAULT 0.30;
