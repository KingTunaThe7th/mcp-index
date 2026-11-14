-- mcp-index schema
--
-- `servers` is the single normalized row per catalog entry. `search_tags` is a
-- denormalized, space-joined copy of the entry's tags so the FTS triggers can
-- index tags without a join.
--
-- The FTS table is external-content (content='servers'): it stores only the
-- inverted index, so the database stays small. Triggers keep it in sync and
-- the standard 'delete' command is used for updates/removals.

CREATE TABLE IF NOT EXISTS servers (
  rid            INTEGER PRIMARY KEY,
  id             TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  title          TEXT,
  description    TEXT,
  homepage       TEXT,
  repo_url       TEXT,
  version        TEXT,
  status         TEXT    NOT NULL DEFAULT 'active',
  is_official    INTEGER NOT NULL DEFAULT 0,
  transport_kind TEXT    NOT NULL DEFAULT 'unknown',
  language       TEXT,
  runtimes       TEXT    NOT NULL DEFAULT '[]',
  categories     TEXT    NOT NULL DEFAULT '[]',
  packages       TEXT    NOT NULL DEFAULT '[]',
  remotes        TEXT    NOT NULL DEFAULT '[]',
  install        TEXT    NOT NULL DEFAULT '[]',
  source         TEXT    NOT NULL,
  sources        TEXT    NOT NULL DEFAULT '[]',
  fetched_at     TEXT    NOT NULL,
  updated_at     TEXT,
  raw            TEXT,
  search_tags    TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_servers_name     ON servers(name);
CREATE INDEX IF NOT EXISTS idx_servers_repo     ON servers(repo_url);
CREATE INDEX IF NOT EXISTS idx_servers_category ON servers(language);
CREATE INDEX IF NOT EXISTS idx_servers_official ON servers(is_official);

CREATE TABLE IF NOT EXISTS tags (
  server_id TEXT NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (server_id, tag)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

CREATE VIRTUAL TABLE IF NOT EXISTS servers_fts USING fts5(
  name,
  title,
  description,
  tags,
  content='servers',
  content_rowid='rid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS servers_ai AFTER INSERT ON servers BEGIN
  INSERT INTO servers_fts(rowid, name, title, description, tags)
  VALUES (new.rid, new.name, IFNULL(new.title, ''), IFNULL(new.description, ''), new.search_tags);
END;

CREATE TRIGGER IF NOT EXISTS servers_ad AFTER DELETE ON servers BEGIN
  INSERT INTO servers_fts(servers_fts, rowid, name, title, description, tags)
  VALUES ('delete', old.rid, old.name, IFNULL(old.title, ''), IFNULL(old.description, ''), old.search_tags);
END;

CREATE TRIGGER IF NOT EXISTS servers_au AFTER UPDATE ON servers BEGIN
  INSERT INTO servers_fts(servers_fts, rowid, name, title, description, tags)
  VALUES ('delete', old.rid, old.name, IFNULL(old.title, ''), IFNULL(old.description, ''), old.search_tags);
  INSERT INTO servers_fts(rowid, name, title, description, tags)
  VALUES (new.rid, new.name, IFNULL(new.title, ''), IFNULL(new.description, ''), new.search_tags);
END;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
