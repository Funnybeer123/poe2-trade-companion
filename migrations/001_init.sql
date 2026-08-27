CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE catalog_items (
  fingerprint TEXT PRIMARY KEY,
  normalized_json TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);

CREATE TABLE item_observations (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  location TEXT NOT NULL,
  raw_text TEXT,
  observed_at_ms INTEGER NOT NULL,
  confidence REAL NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE inventory_snapshots (
  id TEXT PRIMARY KEY,
  captured_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE stash_snapshots (
  id TEXT PRIMARY KEY,
  captured_at_ms INTEGER NOT NULL,
  tab_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE valuations (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE market_comparables_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE sort_rules (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  rule_json TEXT NOT NULL
);

CREATE TABLE listing_history (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  price REAL,
  currency TEXT,
  created_at_ms INTEGER NOT NULL,
  result TEXT
);

CREATE TABLE trade_sessions (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE automation_scenarios (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE qa_action_traces (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  clock_ms INTEGER NOT NULL,
  tick_id INTEGER NOT NULL,
  scenario_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE perception_artifacts (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  path TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE filter_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
