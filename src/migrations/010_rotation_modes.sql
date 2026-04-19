-- Richer rotation rules. Each fixture is now a single 1v1 best-of-3 match
-- between one fighter from each team; rotation_mode picks WHICH fighter
-- from the 5-active roster is fielded:
--   'fixed'   — always priority 0, regardless of stamina or record
--   'stamina' — top priority whose effective stamina >= rotation_threshold
--   'losses'  — top priority whose consecutive_losses < rotation_loss_streak
-- Default stays 'stamina' to preserve pre-change behaviour.

ALTER TABLE team ADD COLUMN rotation_mode TEXT NOT NULL DEFAULT 'stamina'
  CHECK (rotation_mode IN ('fixed', 'stamina', 'losses'));
ALTER TABLE team ADD COLUMN rotation_loss_streak INTEGER NOT NULL DEFAULT 3;

-- Count of consecutive losses for the owned_fighter. Resets to 0 on a
-- win or draw. Used by rotation_mode='losses' without scanning history.
ALTER TABLE owned_fighter ADD COLUMN consecutive_losses INTEGER NOT NULL DEFAULT 0;
