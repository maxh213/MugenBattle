-- Track per-master tournament wins so the fighter profile can show how
-- many brackets a character has won. Counts only exhibition_tournament
-- victories; league championships are a separate concept.

ALTER TABLE fighter ADD COLUMN tournament_wins INTEGER NOT NULL DEFAULT 0;
