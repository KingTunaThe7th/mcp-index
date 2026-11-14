/**
 * Upstream fetch behaviour that matters for polite, identifiable use of other
 * people's servers: a single user agent, bounded retries, and an offline path.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { USER_AGENT } from "../src/config.js";
import { fetchJson, fetchText } from "../src/util/fetch.js";

test("fetchText and fetchJson accept file:// for offline runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-index-fetch-"));
  try {
    const textPath = join(dir, "list.md");
    const jsonPath = join(dir, "servers.json");
    writeFileSync(textPath, "# list\n- [x](https://github.com/x/y) - desc\n");
    writeFileSync(jsonPath, JSON.stringify({ servers: [], metadata: {} }));

    assert.match(await fetchText(pathToFileURL(textPath).href), /# list/);
    assert.deepEqual(await fetchJson(pathToFileURL(jsonPath).href), {
      servers: [],
      metadata: {},
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every request identifies itself with the documented user agent", async () => {
  const seen: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    seen.push(req.headers["user-agent"]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await fetchJson(`http://127.0.0.1:${address.port}/servers`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(seen, [USER_AGENT]);
  assert.match(USER_AGENT, /^mcp-index\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/\S+\)$/);
});
