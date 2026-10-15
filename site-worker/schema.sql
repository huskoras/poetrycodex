-- Reader accounts for poetrycodex.com (D1 database "poetrycodex-readers").
-- Apply with:  npx wrangler d1 execute poetrycodex-readers --remote --file schema.sql
-- A reader is a Google account (its stable "sub"); nothing else identifies them. Their
-- shelf, notes and reading places are stored as the same JSON the site keeps in the
-- browser, one row per kind. Sessions are random tokens of which only a hash is kept.

CREATE TABLE IF NOT EXISTS readers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT    NOT NULL UNIQUE,
  email      TEXT    NOT NULL,
  name       TEXT,
  created_at INTEGER NOT NULL,       -- ms since 1970
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,    -- SHA-256 of the cookie's token, hex
  reader_id  INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_reader ON sessions(reader_id);

CREATE TABLE IF NOT EXISTS reader_data (
  reader_id  INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,       -- "shelf" | "notes" | "reading" | "parallel"
  value      TEXT    NOT NULL,       -- the JSON the site keeps under pc-<key>
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (reader_id, key)
);
