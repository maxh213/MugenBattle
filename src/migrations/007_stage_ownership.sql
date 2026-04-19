-- Stage ownership + market. Each team owns at most one stage (their "home
-- stage"); fixtures where that team is home default to it.
--   owner_team_id: NULL = unclaimed (in the pool), non-NULL = owned.
--   listing_price_cents: NULL = not for sale. Non-NULL = owner listed it.
--   is_unique: default 1. We may later flag common/shared stages (e.g. a
--             training arena) as 0 so multiple teams can "own" the same.

ALTER TABLE stage ADD COLUMN owner_team_id INTEGER REFERENCES team(id);
ALTER TABLE stage ADD COLUMN listing_price_cents INTEGER;
ALTER TABLE stage ADD COLUMN is_unique INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_stage_owner ON stage(owner_team_id);
