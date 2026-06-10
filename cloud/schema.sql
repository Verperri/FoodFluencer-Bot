-- D1 schema for centralized telemetry (image-appeal feedback + technical logs).
-- Apply with: wrangler d1 execute foodfluencer-telemetry --file=cloud/schema.sql

CREATE TABLE IF NOT EXISTS image_feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id   TEXT NOT NULL,
  ts           TEXT NOT NULL,
  source       TEXT,        -- google_maps | duckduckgo | yelp | tripadvisor | foursquare | google_places
  width        INTEGER,
  height       INTEGER,
  blur         REAL,
  brightness   REAL,
  contrast     REAL,
  saturation   REAL,
  colorfulness REAL,
  warmth       REAL,
  center_focus REAL,
  appeal       REAL,
  rank_score   REAL,
  kept         INTEGER,     -- 1 if selected for the post, 0 if ranked out of the pool
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_install ON image_feedback(install_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON image_feedback(created_at);

CREATE TABLE IF NOT EXISTS tech_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id   TEXT NOT NULL,
  entry_id     TEXT,        -- original client-side TechLog entry id
  ts           TEXT,
  level        TEXT,        -- info | warn | error
  source       TEXT,        -- background | popup
  category     TEXT,        -- POST | PHOTO | SEARCH | MEDIA | LOG | SCHEDULE | NAV
  action       TEXT,
  details      TEXT,        -- JSON-encoded details object
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_install  ON tech_logs(install_id);
CREATE INDEX IF NOT EXISTS idx_logs_level    ON tech_logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_created  ON tech_logs(created_at);
