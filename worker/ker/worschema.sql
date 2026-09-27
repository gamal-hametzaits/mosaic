CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub TEXT UNIQUE NOT NULL,
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  is_premium INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pixels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  color INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  day TEXT NOT NULL,
  removed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pixels_xy ON pixels(x, y) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pixels_user_day ON pixels(user_id, day);
CREATE INDEX IF NOT EXISTS idx_pixels_ts ON pixels(ts);
CREATE INDEX IF NOT EXISTS idx_pixels_user ON pixels(user_id);
CREATE TABLE IF NOT EXISTS tiles (
  tx INTEGER NOT NULL,
  ty INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (tx, ty)
);
CREATE TABLE IF NOT EXISTS overview (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  val TEXT
);
