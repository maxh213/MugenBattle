-- Persist each league's promote-per-tier so the pyramid UI knows which
-- rows to colour as promotion/relegation/drop zones. 3 = Premier League
-- default; matches what autoCreateSeason uses.

ALTER TABLE league ADD COLUMN promote_per_tier INTEGER NOT NULL DEFAULT 3;
