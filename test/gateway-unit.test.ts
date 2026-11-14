import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ConfigError, parseGatewayConfig } from "../src/gateway/config.js";
import { GatewayManager } from "../src/gateway/manager.js";
import {
  cleanDescription,
  namespaceName,
  rewriteResourceUri,
  splitNamespaced,
  unrewriteResourceUri,
  validateAlias,
} from "../src/gateway/router.js";
import { startHttpServer } from "../src/http/server.js";
import type { SearchHit } from "../src/types.js";

test("namespacing is reversible and separator-safe", () => {
  assert.equal(namespaceName("files", "read_file"), "files__read_file");
  assert.deepEqual(splitNamespaced("files__read_file"), {
    alias: "files",
    name: "read_file",
  });
  assert.equal(splitNamespaced("no-separator"), null);
  assert.equal(splitNamespaced("__leading"), null);

  assert.throws(() => validateAlias("a__b"), /must not contain/);
  assert.throws(() => validateAlias("bad alias"), /must match/);
  assert.doesNotThrow(() => validateAlias("good-alias_1"));
});

test("resource URIs survive a round trip", () => {
  const original = "file:///tmp/a b/c?x=1&y=%20";
  const wrapped = rewriteResourceUri("fs", original);
  assert.ok(wrapped.startsWith("mcp-index://fs/"));
  assert.equal(unrewriteResourceUri(wrapped), original);
  assert.equal(unrewriteResourceUri("https://example.com"), null);
});

test("cleanDescription strips escapes but keeps prose", () => {
  assert.equal(cleanDescription("\u001b[31mRead\u001b[0m files"), "Read files");
  assert.equal(cleanDescription(undefined), undefined);
});

test("config validation rejects unknown keys and bad shapes", () => {
  const ok = parseGatewayConfig({
    gateway: { driver: "bwrap", port: 8080 },
    servers: { files: { command: "npx", args: ["-y", "x"] } },
  });
  assert.equal(ok.settings.driver, "bwrap");
  assert.equal(ok.settings.port, 8080);
  assert.equal(ok.servers.files?.command, "npx");

  assert.throws(
    () => parseGatewayConfig({ servers: { files: { command: "npx", mount: [] } } }),
    (error: unknown) =>
      error instanceof ConfigError && /not a recognised option/.test(error.message),
  );
  assert.throws(
    () => parseGatewayConfig({ servers: { "bad__alias": { command: "x" } } }),
    /must not contain/,
  );
  assert.throws(
    () => parseGatewayConfig({ servers: { files: { transport: "stdio" } } }),
    /requires "command"/,
  );
  assert.throws(
    () => parseGatewayConfig({ servers: { remote: { transport: "http" } } }),
    /requires "url"/,
  );
  assert.throws(
    () =>
      parseGatewayConfig({
        servers: { files: { command: "x", mounts: [{ source: "/tmp", target: "relative" }] } },
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      parseGatewayConfig({
        servers: {
          files: { command: "x", mounts: [{ source: "/tmp", target: "/w", mode: "rwx" }] },
        },
      }),
    /must be "ro" or "rw"/,
  );
  assert.throws(() => parseGatewayConfig({ gateway: { driver: "magic" } }), /must be one of/);
});

const hit: SearchHit = {
  id: "io.test/postgres",
  name: "Postgres",
  title: null,
  description: "SQL access",
  homepage: null,
  repoUrl: null,
  version: "1.0.0",
  status: "active",
  isOfficial: false,
  transportKind: "stdio",
  language: "typescript",
  runtimes: [],
  categories: ["databases"],
  packages: [],
  remotes: [],
  install: [],
  source: "registry",
  sources: ["registry"],
  fetchedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  raw: { big: "blob" },
  score: 1,
  highlight: null,
};

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("http surface enforces token, host and origin checks", async () => {
  const token = "test-token-with-enough-entropy-1234";
  const manager = new GatewayManager({});
  const catalog = {
    search: () => [hit],
    stats: () => ({
      total: 1,
      bySource: { registry: 1 },
      byTransport: { stdio: 1 },
      official: 0,
      lastSync: null,
    }),
  };

  const server = await startHttpServer({ port: 0, token, manager, catalog });
  const auth = { authorization: `Bearer ${token}` };

  try {
    const dashboard = await request(server.port, "/");
    assert.equal(dashboard.status, 200);
    assert.match(String(dashboard.headers["content-type"]), /text\/html/);
    assert.match(String(dashboard.headers["content-security-policy"]), /script-src 'nonce-/);
    assert.match(dashboard.body, /mcp-index/);

    assert.equal((await request(server.port, "/api/stats")).status, 401);

    const stats = await request(server.port, "/api/stats", { headers: auth });
    assert.equal(stats.status, 200);
    assert.equal(JSON.parse(stats.body).total, 1);

    const search = await request(server.port, "/api/search?q=postgres&limit=5", {
      headers: auth,
    });
    assert.equal(search.status, 200);
    const payload = JSON.parse(search.body);
    assert.equal(payload.count, 1);
    assert.equal(payload.hits[0].id, "io.test/postgres");
    assert.equal(payload.hits[0].raw, undefined, "raw blobs must not be served");

    // DNS rebinding: a foreign Host header is rejected.
    const rebinding = await request(server.port, "/api/stats", {
      headers: { ...auth, host: "evil.example.com" },
    });
    assert.equal(rebinding.status, 421);

    // Cross-site browser requests are rejected.
    const crossOrigin = await request(server.port, "/api/stats", {
      headers: { ...auth, origin: "https://evil.example.com" },
    });
    assert.equal(crossOrigin.status, 403);

    // The MCP endpoint requires the token too.
    assert.equal((await request(server.port, "/mcp", { method: "POST", body: "{}" })).status, 401);

    const init = await request(server.port, "/mcp", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(init.status, 200);
    const rpc = JSON.parse(init.body);
    assert.equal(rpc.result?.serverInfo?.name, "mcp-index-gateway");
  } finally {
    await server.close();
  }
});
