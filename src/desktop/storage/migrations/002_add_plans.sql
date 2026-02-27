-- Migration 002: plans table removed (planning tool simplified)
-- Drop the table if it was created by a previous version.
DROP TABLE IF EXISTS plans;

-- Update schema version
INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (2, strftime('%s', 'now'));
