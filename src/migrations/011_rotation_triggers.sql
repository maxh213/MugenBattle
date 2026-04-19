-- Rotation config v2: independent toggles instead of a single enum mode.
-- Either (or both) can fire a rotation; if both are off the team keeps a
-- fixed lineup (priority 0 always).

ALTER TABLE team ADD COLUMN rotate_on_stamina INTEGER NOT NULL DEFAULT 1;
ALTER TABLE team ADD COLUMN rotate_on_losses  INTEGER NOT NULL DEFAULT 0;

-- New default threshold is 0.85 (was 0.30). Pulls fighters much sooner
-- now that stamina recovery is event-driven (+0.25 per teammate match)
-- instead of time-based.
UPDATE team SET rotation_threshold = 0.85 WHERE rotation_threshold = 0.30;
