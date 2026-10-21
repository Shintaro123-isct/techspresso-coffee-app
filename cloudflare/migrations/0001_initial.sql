CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  last_commit_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
  request_id TEXT PRIMARY KEY,
  signature TEXT NOT NULL,
  event TEXT NOT NULL CHECK (json_valid(event)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  returned_at TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL CHECK (json_valid(data))
);
CREATE INDEX IF NOT EXISTS orders_returned ON orders(returned_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at, id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings VALUES ('wait_minutes', '15');
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limits_expires ON rate_limits(expires_at);
