import assert from "node:assert/strict";
import test from "node:test";
import { parseRegistryResponse } from "../src/sources/registry.js";
import { parseAwesomeReadme, repoFromUrl } from "../src/sources/awesome.js";
import { localServersToRaw, parseLocalConfig } from "../src/sources/local.js";
import { canonicalRepo, deriveInstall, normalizeServers, slugify } from "../src/ingest/normalize.js";
import type { RawServer } from "../src/types.js";

const REGISTRY_PAYLOAD = {
  servers: [
    {
      server: {
        name: "io.acme/postgres",
        title: "Acme Postgres",
        description: "SQL access for agents",
        version: "2.0.0",
        websiteUrl: "https://acme.dev",
        repository: { url: "https://github.com/acme/pg-mcp.git" },
        packages: [
          {
            registryType: "npm",
            identifier: "@acme/pg-mcp",
            version: "2.0.0",
            transport: { type: "stdio" },
          },
        ],
        remotes: [
          {
            type: "streamable-http",
            url: "https://pg.acme.dev/mcp",
            headers: { Authorization: "Bearer super-secret-token" },
          },
        ],
      },
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          status: "active",
          updatedAt: "2026-02-02T00:00:00.000Z",
          isLatest: true,
        },
      },
    },
    {
      // Withdrawn servers must not be indexed.
      server: { name: "io.acme/withdrawn", version: "1.0.0" },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } },
    },
    {
      // Bare entries (no envelope) are tolerated.
      name: "io.bare/one",
      description: "No envelope",
      version: "0.1.0",
    },
    { nonsense: true },
  ],
  metadata: { nextCursor: null },
};

test("registry parser is schema tolerant and drops secrets", () => {
  const { servers, nextCursor } = parseRegistryResponse(REGISTRY_PAYLOAD);

  assert.equal(nextCursor, null);
  assert.equal(servers.length, 2, "withdrawn + malformed entries are skipped");

  const postgres = servers.find((entry) => entry.id === "io.acme/postgres");
  assert.ok(postgres);
  assert.equal(postgres.version, "2.0.0");
  assert.equal(postgres.title, "Acme Postgres");
  assert.equal(postgres.repoUrl, "https://github.com/acme/pg-mcp.git");
  assert.equal(postgres.updatedAt, "2026-02-02T00:00:00.000Z");
  assert.equal(postgres.packages?.[0]?.registryType, "npm");
  assert.equal(postgres.packages?.[0]?.transport, "stdio");
  assert.deepEqual(postgres.remotes?.[0]?.headerNames, ["Authorization"]);

  // Header *values* must never be recorded.
  assert.ok(!JSON.stringify(servers).includes("super-secret-token"));

  const bare = servers.find((entry) => entry.id === "io.bare/one");
  assert.ok(bare, "bare entries parse");
});

const AWESOME_MARKDOWN = `# Awesome MCP Servers

* [What is MCP?](#what-is-mcp)
* [Clients](#clients)

## Server Implementations

### 🗄️ Databases
- [acme/pg-mcp](https://github.com/acme/pg-mcp) [![acme/pg-mcp MCP server](https://glama.ai/mcp/servers/acme/pg-mcp/badges/score.svg)](https://glama.ai/mcp/servers/acme/pg-mcp) 📇 - SQL access for agents.
- [other/thing](https://github.com/other/thing) 🐍 ☁️ - A hosted thing.
- [relative](#anchor) - should be ignored

### 🧪 Testing
- [official/server](https://github.com/official/server) 🎖️ 📇 - The official one.

## Clients
- [some/client](https://github.com/some/client) 📇 - Not a server.
`;

test("awesome parser handles badges, emoji markers and sections", () => {
  const entries = parseAwesomeReadme(AWESOME_MARKDOWN);

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["acme/pg-mcp", "other/thing", "official/server"],
  );

  const [pg, other, official] = entries;
  assert.ok(pg && other && official);

  assert.equal(pg.description, "SQL access for agents.");
  assert.equal(pg.language, "typescript");
  assert.equal(pg.category, "Databases");
  assert.equal(pg.official, false);

  assert.equal(other.language, "python");
  assert.equal(other.official, false);

  assert.equal(official.official, true);
  assert.equal(official.category, "Testing");
});

test("repoFromUrl normalizes github links", () => {
  assert.equal(repoFromUrl("https://github.com/acme/pg-mcp"), "https://github.com/acme/pg-mcp");
  assert.equal(
    repoFromUrl("https://github.com/acme/pg-mcp/tree/main"),
    "https://github.com/acme/pg-mcp",
  );
  assert.equal(repoFromUrl("https://example.com/x"), null);
});


test("local configs import names but never env values", () => {
  const config = parseLocalConfig(
    JSON.stringify({
      mcpServers: {
        files: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { GITHUB_TOKEN: "ghp_should_not_be_stored" },
        },
        hosted: { url: "https://hosted.example.com/mcp", type: "http" },
        off: { command: "x", disabled: true },
      },
    }),
    "/home/test/config.json",
  );

  const raws = localServersToRaw([config]);
  assert.equal(raws.length, 2, "disabled servers are skipped");

  const files = raws.find((entry) => entry.name === "files");
  assert.ok(files);
  assert.deepEqual(files.envNames, ["GITHUB_TOKEN"]);
  assert.ok(!JSON.stringify(raws).includes("ghp_should_not_be_stored"));

  const hosted = raws.find((entry) => entry.name === "hosted");
  assert.equal(hosted?.remotes?.[0]?.url, "https://hosted.example.com/mcp");
});

test("canonicalRepo and slugify", () => {
  assert.equal(canonicalRepo("https://github.com/Acme/PG-MCP.git"), "github.com/acme/pg-mcp");
  assert.equal(canonicalRepo("https://www.github.com/acme/pg-mcp/"), "github.com/acme/pg-mcp");
  assert.equal(canonicalRepo("not a url"), null);
  assert.equal(canonicalRepo(null), null);
  assert.equal(slugify("My Weird Server!"), "my-weird-server");
});

test("normalize merges sources and keeps registry precedence", () => {
  const registry = parseRegistryResponse(REGISTRY_PAYLOAD).servers;
  const awesome: RawServer[] = parseAwesomeReadme(AWESOME_MARKDOWN).map((entry) => ({
    source: "awesome" as const,
    name: entry.name,
    description: entry.description,
    homepage: entry.url,
    repoUrl: repoFromUrl(entry.url),
    language: entry.language,
    categories: entry.category ? [entry.category] : [],
    isOfficial: entry.official,
  }));

  const records = normalizeServers([...registry, ...awesome], "2026-03-03T00:00:00.000Z");
  const postgres = records.find((record) => record.id === "io.acme/postgres");

  assert.ok(postgres, "registry id survives merging");
  assert.deepEqual(postgres.sources, ["registry", "awesome"]);
  assert.equal(postgres.description, "SQL access for agents");
  assert.deepEqual(postgres.categories, ["Databases"]);
  assert.equal(postgres.language, "typescript");
  assert.equal(postgres.transportKind, "both");
  assert.ok(postgres.install.some((snippet) => snippet.kind === "npx"));
  assert.ok(postgres.install.some((snippet) => snippet.kind === "remote"));

  // The awesome-only entry keeps a repo-derived id.
  assert.ok(records.some((record) => record.id === "github:other/thing"));
});

test("deriveInstall produces runnable commands", () => {
  const snippets = deriveInstall(
    [
      { registryType: "npm", identifier: "@acme/pg-mcp", version: "2.0.0" },
      { registryType: "pypi", identifier: "acme-mcp" },
      { registryType: "oci", identifier: "ghcr.io/acme/mcp:1" },
    ],
    [{ type: "streamable-http", url: "https://acme.dev/mcp" }],
    "npx",
    ["-y", "acme"],
  );

  assert.deepEqual(
    snippets.map((snippet) => snippet.kind),
    ["npx", "uvx", "docker", "remote", "command"],
  );
  assert.deepEqual(snippets[0]?.args, ["-y", "@acme/pg-mcp@2.0.0"]);
});

test("duplicate observations collapse into one row", () => {
  const raw: RawServer = {
    source: "registry",
    id: "io.dup/x",
    name: "Dup",
    repoUrl: "https://github.com/dup/x",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const records = normalizeServers([raw, { ...raw, updatedAt: "2026-05-05T00:00:00.000Z" }]);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, "io.dup/x");
});
