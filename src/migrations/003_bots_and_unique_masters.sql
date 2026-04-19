-- Platform v2 M5.5: bot players, unique-master ownership, retirement.
-- Model shift:
--   - Every master fighter can be owned by at most one team globally —
--     EXCEPT KFM (the training dummy), which any team can hold.
--   - Bot users fill empty league slots so seasons always run. They hold real
--     masters during a season; on season end those rosters retire and the
--     masters flow back to the unclaimed pool for new signups.
--   - `is_retired` marks owned_fighter rows that have been released back to
--     the pool (preserving history instead of deleting rows).
-- Uniqueness is enforced in the application (bot seeder + signup draw) for
-- now; once we're confident there are no races we'll add a partial index.

ALTER TABLE user_account ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;

ALTER TABLE fighter ADD COLUMN is_unique INTEGER NOT NULL DEFAULT 1;
UPDATE fighter SET is_unique = 0 WHERE file_name = 'kfm';

ALTER TABLE owned_fighter ADD COLUMN is_retired INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_owned_fighter_master_active
  ON owned_fighter(master_fighter_id) WHERE is_retired = 0;
