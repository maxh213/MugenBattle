-- When a match crash doesn't name a specific char (e.g. a Go runtime panic
-- deep in Ikemen's palette code), we can't know which of the two combatants
-- was at fault. Instead, increment a "suspect" counter on BOTH masters.
-- After a threshold (3), auto-deactivate. Keeps the roster clean without
-- over-eager deactivation on the first unexplained crash.

ALTER TABLE fighter ADD COLUMN crash_suspect_count INTEGER NOT NULL DEFAULT 0;
