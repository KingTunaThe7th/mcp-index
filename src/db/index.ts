import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  InstallSnippet,
  PackageRef,
  RemoteRef,
  SearchHit,
  SearchOptions,
  ServerRecord,
  SourceName,
  TransportKind,
} from "../types.js";

export type { DatabaseSync, StatementSync };

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

export const SCHEMA_VERSION = "1";

export interface OpenDbOptions {
  readOnly?: boolean;
  /** Skip WAL/foreign-key pragmas (used by read-only callers). */
  skipPragmas?: boolean;
}

export function loadSchemaSql(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}

export function openDb(location: string, options: OpenDbOptions = {}): DatabaseSync {
  const inMemory = location === ":memory:";
  if (!inMemory && !options.readOnly) {
    mkdirSync(dirname(location), { recursive: true });
  }

  const db = new DatabaseSync(location, {
    readOnly: options.readOnly ?? false,
    timeout: 5_000,
  });

  if (!options.skipPragmas) {
    if (!options.readOnly) {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      db.exec("PRAGMA foreign_keys = ON;");
    }
    db.exec("PRAGMA busy_timeout = 5000;");
  }

  if (!options.readOnly) migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(loadSchemaSql());
  setMeta(db, "schema_version", SCHEMA_VERSION);
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? String(row.value) : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function rowToRecord(row: Record<string, unknown>): ServerRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    title: asString(row.title),
    description: asString(row.description),
    homepage: asString(row.homepage),
    repoUrl: asString(row.repo_url),
    version: asString(row.version),
    status: asString(row.status) ?? "active",
    isOfficial: Number(row.is_official) === 1,
    transportKind: (asString(row.transport_kind) ?? "unknown") as TransportKind,
    language: asString(row.language),
    runtimes: parseJson<string[]>(row.runtimes, []),
    categories: parseJson<string[]>(row.categories, []),
    packages: parseJson<PackageRef[]>(row.packages, []),
    remotes: parseJson<RemoteRef[]>(row.remotes, []),
    install: parseJson<InstallSnippet[]>(row.install, []),
    source: (asString(row.source) ?? "registry") as SourceName,
    sources: parseJson<SourceName[]>(row.sources, []),
    fetchedAt: asString(row.fetched_at) ?? "",
    updatedAt: asString(row.updated_at),
    raw: parseJson<unknown>(row.raw, null),
  };
}

const SELECT_COLUMNS = `s.id, s.name, s.title, s.description, s.homepage, s.repo_url, s.version,
  s.status, s.is_official, s.transport_kind, s.language, s.runtimes, s.categories,
  s.packages, s.remotes, s.install, s.source, s.sources, s.fetched_at, s.updated_at, s.raw`;

const UPSERT_SQL = `INSERT INTO servers (
    id, name, title, description, homepage, repo_url, version, status, is_official,
    transport_kind, language, runtimes, categories, packages, remotes, install,
    source, sources, fetched_at, updated_at, raw, search_tags
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    title = excluded.title,
    description = excluded.description,
    homepage = excluded.homepage,
    repo_url = excluded.repo_url,
    version = excluded.version,
    status = excluded.status,
    is_official = excluded.is_official,
    transport_kind = excluded.transport_kind,
    language = excluded.language,
    runtimes = excluded.runtimes,
    categories = excluded.categories,
    packages = excluded.packages,
    remotes = excluded.remotes,
    install = excluded.install,
    source = excluded.source,
    sources = excluded.sources,
    fetched_at = excluded.fetched_at,
    updated_at = excluded.updated_at,
    raw = excluded.raw,
    search_tags = excluded.search_tags`;

export interface UpsertResult {
  inserted: number;
  updated: number;
}

export function upsertServerRecords(db: DatabaseSync, records: ServerRecord[]): UpsertResult {
  const existing = new Set(
    db.prepare("SELECT id FROM servers").all().map((row) => String(row.id)),
  );

  const upsert = db.prepare(UPSERT_SQL);
  const clearTags = db.prepare("DELETE FROM tags WHERE server_id = ?");
  const addTag = db.prepare("INSERT OR IGNORE INTO tags(server_id, tag) VALUES (?, ?)");

  let inserted = 0;
  let updated = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const record of records) {
      const tags = Array.from(
        new Set(
          [...record.categories, ...record.runtimes, record.language ?? ""]
            .map((tag) => tag.trim().toLowerCase())
            .filter((tag) => tag.length > 0),
        ),
      );

      upsert.run(
        record.id,
        record.name,
        record.title,
        record.description,
        record.homepage,
        record.repoUrl,
        record.version,
        record.status,
        record.isOfficial ? 1 : 0,
        record.transportKind,
        record.language,
        JSON.stringify(record.runtimes),
        JSON.stringify(record.categories),
        JSON.stringify(record.packages),
        JSON.stringify(record.remotes),
        JSON.stringify(record.install),
        record.source,
        JSON.stringify(record.sources),
        record.fetchedAt,
        record.updatedAt,
        record.raw === null || record.raw === undefined ? null : JSON.stringify(record.raw),
        tags.join(" "),
      );

      clearTags.run(record.id);
      for (const tag of tags) addTag.run(record.id, tag);

      if (existing.has(record.id)) updated += 1;
      else inserted += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { inserted, updated };
}

export function getServer(db: DatabaseSync, id: string): ServerRecord | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM servers s WHERE s.id = ? OR s.name = ? LIMIT 1`)
    .get(id, id);
  return row ? rowToRecord(row) : null;
}

export function findServersByRepo(db: DatabaseSync, repoUrl: string): ServerRecord[] {
  return db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM servers s WHERE s.repo_url = ?`)
    .all(repoUrl)
    .map(rowToRecord);
}


/**
 * Turn free text into a safe FTS5 MATCH expression.
 *
 * Users never supply raw FTS syntax: `"`, `*`, `NEAR(`, parentheses and `:`
 * (column filters) are stripped, then each surviving term is quoted and
 * expanded as a prefix query. That keeps `MATCH` from throwing or from
 * targeting hidden columns.
 */
export function extractTerms(input: string | undefined): string[] {
  if (!input) return [];
  return (input.match(/[\p{L}\p{N}][\p{L}\p{N}_.@/+-]*/gu) ?? [])
    .map((term) => term.replace(/["^*(){}:,]/g, "").trim())
    .filter((term) => term.length > 0)
    .slice(0, 12);
}

export function buildFtsQuery(input: string | undefined, matchAll = false): string | null {
  const terms = extractTerms(input);
  if (terms.length === 0) return null;
  const joiner = matchAll ? " OR " : " AND ";
  return terms.map((term) => `"${term}"*`).join(joiner);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Highlight query terms in JavaScript.
 *
 * FTS5's own `snippet()`/`highlight()` are unusable here: node:sqlite returns
 * their result as an opaque pointer and raises "SQL logic error". Doing it in
 * JS is portable, works for the LIKE fallback too, and keeps the output
 * sanitized by the caller.
 */
export function highlightText(
  text: string | null,
  terms: string[],
  maxLength = 220,
): string | null {
  if (!text) return null;
  if (terms.length === 0 || text.length <= maxLength) {
    return terms.length === 0 ? text : markTerms(text, terms);
  }

  const lower = text.toLowerCase();
  let firstMatch = -1;
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index !== -1 && (firstMatch === -1 || index < firstMatch)) firstMatch = index;
  }

  const start = firstMatch === -1 ? 0 : Math.max(0, firstMatch - 40);
  const slice = text.slice(start, start + maxLength);
  const prefix = start > 0 ? "..." : "";
  const suffix = start + maxLength < text.length ? "..." : "";
  return `${prefix}${markTerms(slice, terms)}${suffix}`;
}

function markTerms(text: string, terms: string[]): string {
  let output = text;
  for (const term of terms) {
    output = output.replace(new RegExp(`(${escapeRegExp(term)})`, "gi"), "[$1]");
  }
  return output;
}

export function searchServers(db: DatabaseSync, options: SearchOptions = {}): SearchHit[] {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const match = buildFtsQuery(options.query, options.matchAll);

  const where: string[] = [];
  const params: unknown[] = [];

  if (options.category) {
    where.push("s.id IN (SELECT server_id FROM tags WHERE tag = ?)");
    params.push(options.category.trim().toLowerCase());
  }
  if (options.transport) {
    where.push("(s.transport_kind = ? OR s.transport_kind = 'both')");
    params.push(options.transport);
  }
  if (options.language) {
    where.push("s.language = ?");
    params.push(options.language);
  }
  if (options.officialOnly) {
    where.push("s.is_official = 1");
  }

  const filters = where.length > 0 ? where.join(" AND ") : "1 = 1";
  const bindings = params as never[];
  const terms = extractTerms(options.query);

  const toHit = (row: Record<string, unknown>, score: number): SearchHit => {
    const record = rowToRecord(row);
    return {
      ...record,
      score,
      highlight: highlightText(record.description ?? record.title, terms),
    };
  };

  if (match) {
    try {
      return db
        .prepare(
          `SELECT ${SELECT_COLUMNS},
             bm25(servers_fts, 12.0, 8.0, 1.0, 5.0) AS rank,
             (CASE WHEN s.install = '[]' THEN 1 ELSE 0 END) AS missing_launch
           FROM servers_fts
           JOIN servers s ON s.rid = servers_fts.rowid
           WHERE servers_fts MATCH ? AND ${filters}
           ORDER BY rank ASC, missing_launch ASC, s.is_official DESC, s.name ASC
           LIMIT ? OFFSET ?`,
        )
        .all(match, ...bindings, limit, offset)
        .map((row) => toHit(row, -Number(row.rank ?? 0)));
    } catch {
      // Fall back to a LIKE scan if FTS5 rejects the expression for any
      // reason. Correctness beats ranking.
      const like = `%${(options.query ?? "").replace(/[%_\\]/g, "\\$&")}%`;
      return db
        .prepare(
          `SELECT ${SELECT_COLUMNS}, 0 AS rank
           FROM servers s
           WHERE (s.name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')
             AND ${filters}
           ORDER BY s.is_official DESC, s.name ASC
           LIMIT ? OFFSET ?`,
        )
        .all(like, like, like, ...bindings, limit, offset)
        .map((row) => toHit(row, 0));
    }
  }

  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS}, 0 AS rank
       FROM servers s
       WHERE ${filters}
       ORDER BY s.is_official DESC, s.name ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...bindings, limit, offset)
    .map((row) => toHit(row, 0));
}



export interface CategoryCount {
  tag: string;
  count: number;
}

export function listCategories(db: DatabaseSync, limit = 200): CategoryCount[] {
  return db
    .prepare("SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag ASC LIMIT ?")
    .all(limit)
    .map((row) => ({ tag: String(row.tag), count: Number(row.count) }));
}

export interface IndexStats {
  total: number;
  bySource: Record<string, number>;
  byTransport: Record<string, number>;
  official: number;
  lastSync: string | null;
}

export function getStats(db: DatabaseSync): IndexStats {
  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM servers").get()?.n ?? 0);
  const official = Number(
    db.prepare("SELECT COUNT(*) AS n FROM servers WHERE is_official = 1").get()?.n ?? 0,
  );

  const bySource: Record<string, number> = {};
  for (const row of db.prepare("SELECT source, COUNT(*) AS n FROM servers GROUP BY source").all()) {
    bySource[String(row.source)] = Number(row.n);
  }

  const byTransport: Record<string, number> = {};
  for (const row of db
    .prepare("SELECT transport_kind, COUNT(*) AS n FROM servers GROUP BY transport_kind")
    .all()) {
    byTransport[String(row.transport_kind)] = Number(row.n);
  }

  return { total, bySource, byTransport, official, lastSync: getMeta(db, "last_sync") };
}
