import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFtsQuery,
  getServer,
  getStats,
  listCategories,
  openDb,
  searchServers,
  upsertServerRecords,
} from "../src/db/index.js";
import type { ServerRecord } from "../src/types.js";

function record(overrides: Partial<ServerRecord> & { id: string }): ServerRecord {
  return {
    name: overrides.id,
    title: null,
    description: null,
    homepage: null,
    repoUrl: null,
    version: null,
    status: "active",
    isOfficial: false,
    transportKind: "stdio",
    language: null,
    runtimes: [],
    categories: [],
    packages: [],
    remotes: [],
    install: [],
    source: "registry",
    sources: ["registry"],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    raw: null,
    ...overrides,
  };
}

const SAMPLE: ServerRecord[] = [
  record({
    id: "io.test/postgres",
    name: "Postgres MCP",
    description: "Query PostgreSQL databases with read-only SQL",
    language: "typescript",
    categories: ["databases"],
    isOfficial: true,
    install: [{ kind: "npx", command: "npx", args: ["-y", "pg-mcp"] }],
  }),
  record({
    id: "io.test/files",
    name: "Filesystem MCP",
    description: "Read and write files inside a sandboxed directory",
    language: "python",
    categories: ["developer tools"],
    transportKind: "remote",
    remotes: [{ type: "streamable-http", url: "https://files.example.com/mcp" }],
    install: [{ kind: "remote", url: "https://files.example.com/mcp" }],
  }),
  record({
    id: "io.test/slack",
    name: "Slack Bridge",
    description: "Send messages to Slack channels",
    language: "typescript",
    categories: ["communication"],
  }),
];

test("upsert, search and stats round-trip", () => {
  const db = openDb(":memory:");

  const first = upsertServerRecords(db, SAMPLE);
  assert.equal(first.inserted, 3);
  assert.equal(first.updated, 0);

  const again = upsertServerRecords(db, SAMPLE);
  assert.equal(again.inserted, 0);
  assert.equal(again.updated, 3);

  const hits = searchServers(db, { query: "postgres" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, "io.test/postgres");
  assert.ok((hits[0]?.score ?? 0) > 0);

  // Relevance: a description match should still be found.
  const files = searchServers(db, { query: "sandboxed" });
  assert.equal(files.length, 1);
  assert.equal(files[0]?.id, "io.test/files");

  const stats = getStats(db);
  assert.equal(stats.total, 3);
  assert.equal(stats.official, 1);
  assert.deepEqual(stats.bySource, { registry: 3 });

  const categories = listCategories(db).map((entry) => entry.tag);
  assert.ok(categories.includes("databases"));
  assert.ok(categories.includes("typescript"));

  assert.equal(getServer(db, "io.test/slack")?.name, "Slack Bridge");
  db.close();
});

test("filters compose", () => {
  const db = openDb(":memory:");
  upsertServerRecords(db, SAMPLE);

  assert.equal(searchServers(db, { category: "databases" }).length, 1);
  assert.equal(searchServers(db, { language: "typescript" }).length, 2);
  assert.equal(searchServers(db, { officialOnly: true }).length, 1);
  assert.equal(searchServers(db, { transport: "remote" }).length, 1);
  assert.equal(searchServers(db, { category: "databases", language: "python" }).length, 0);
  db.close();
});

test("FTS stays in sync through updates and deletes", () => {
  const db = openDb(":memory:");
  upsertServerRecords(db, [record({ id: "io.test/x", name: "Alpha", description: "old wording" })]);

  assert.equal(searchServers(db, { query: "old" }).length, 1);

  upsertServerRecords(db, [record({ id: "io.test/x", name: "Alpha", description: "brand new text" })]);
  assert.equal(searchServers(db, { query: "old" }).length, 0, "stale FTS row after update");
  assert.equal(searchServers(db, { query: "brand" }).length, 1);

  db.prepare("DELETE FROM servers WHERE id = ?").run("io.test/x");
  assert.equal(searchServers(db, { query: "brand" }).length, 0, "stale FTS row after delete");
  db.close();
});

test("buildFtsQuery cannot inject syntax", () => {
  assert.equal(buildFtsQuery(""), null);
  assert.equal(buildFtsQuery("   "), null);
  assert.equal(buildFtsQuery("postgres"), '"postgres"*');

  const injected = buildFtsQuery('foo" OR name:bar NEAR(baz)');
  assert.ok(injected);
  assert.ok(!injected.includes(":"));
  assert.ok(injected.startsWith('"foo"*'));
  // The whole string must be quoted terms joined by AND.
  assert.ok(!/["]\s+OR\s+["]/.test(injected));
});

test("queries that FTS rejects fall back to LIKE instead of throwing", () => {
  const db = openDb(":memory:");
  upsertServerRecords(db, SAMPLE);

  // A lone quote used to make MATCH throw.
  const hits = searchServers(db, { query: '""' });
  assert.ok(Array.isArray(hits));
  db.close();
});

test("limit and offset are clamped", () => {
  const db = openDb(":memory:");
  upsertServerRecords(db, SAMPLE);

  assert.equal(searchServers(db, { limit: 1 }).length, 1);
  assert.equal(searchServers(db, { limit: 100000 }).length, 3);
  assert.equal(searchServers(db, { offset: 10 }).length, 0);
  db.close();
});
