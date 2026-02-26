-- Add plans table for persistent plan storage
-- Migration: 002_add_plans
-- Feature: 029-planning-tool-v2

CREATE TABLE IF NOT EXISTS plans (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_plans_updated ON plans(updated_at);

-- Update schema version
INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (2, strftime('%s', 'now'));
