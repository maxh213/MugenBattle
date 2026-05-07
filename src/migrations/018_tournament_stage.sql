-- Optional fixed stage for an exhibition tournament. NULL means pick a
-- random active stage for each match (existing behaviour). Setting this
-- pins every match in the bracket to one stage.

ALTER TABLE exhibition_tournament ADD COLUMN stage_id INTEGER REFERENCES stage(id);
