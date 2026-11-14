/**
 * End-to-end gateway test.
 *
 * This is the test that actually proves the project's claims:
 *   - a third-party server really is spawned through bubblewrap
 *   - the child cannot see the parent's secret environment
 *   - `$HOME` is the ephemeral sandbox home, not the real one
 *   - tool names are namespaced and routed back correctly
 *   - a destructive tool is refused when the client cannot elicit approval
 *
 * It is skipped (not failed) where bubblewrap is unavailable, because the
 * gateway is expected to refuse unsandboxed operation.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { detectCapabilities } from "../src/sandbox/detect.js";

const capabilities = detectCapabilities();
const canSandbox = capabilities.bwrap;
const projectRoot = resolve(import.meta.dirname, "..");

test("gateway aggregates a sandboxed server", { timeout: 60_000 }, async (t) => {
  if (!canSandbox) {
    t.skip("bubblewrap unavailable; the gateway refuses unsandboxed mounts by design");
    return;
  }

  const home = mkdtempSync(join(tmpdir(), "mcp-index-gw-"));
  const configPath = join(home, "mcp-index.json");
  mkdirSync(join(home, "state"), { recursive: true });

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        gateway: { driver: "bwrap" },
        servers: {
          echo: {
            command: process.execPath,
            // Inside the sandbox the project is mounted at /work, so arguments
            // refer to sandbox paths, not host paths.
            args: ["/work/test/fixtures/echo-server.mjs"],
            cwd: projectRoot,
            mounts: [{ source: projectRoot, target: "/work", mode: "ro" }],
            network: "none",
            destructiveTools: ["write_thing"],
          },
        },
      },
      null,
      2,
    ),
  );

  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js", "gateway", "--config", configPath],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      MCP_INDEX_HOME: home,
      // Must NOT reach the child.
      MCP_INDEX_TEST_SECRET: "super-secret-value",
    },
    stderr: "pipe",
  });

  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["echo__echo", "echo__write_thing"]);

    const echo = tools.find((tool) => tool.name === "echo__echo");
    assert.ok(echo, "echo tool should be listed");
    assert.ok(
      !echo.description?.includes("\u001b["),
      `description must be sanitized, got: ${JSON.stringify(echo.description)}`,
    );
    assert.match(echo.description ?? "", /provided by server "echo"/);

    const result = (await client.callTool({
      name: "echo__echo",
      arguments: { text: "hello" },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    const text = result.content[0]?.text ?? "";
    assert.match(text, /^echo:hello/);
    assert.match(text, /env:clean/, "the parent's secret env var must not reach the child");
    assert.match(text, /home:\/sandbox-home/, "HOME must be the ephemeral sandbox home");

    // Destructive + no elicitation support on this client => refusal.
    const denied = (await client.callTool({
      name: "echo__write_thing",
      arguments: { path: "/tmp/x" },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    assert.equal(denied.isError, true, "destructive tool must fail closed without elicitation");
    assert.match(denied.content[0]?.text ?? "", /Refused/);

    // Unknown tool must not be routed anywhere.
    await assert.rejects(
      () => client.callTool({ name: "nope__nope", arguments: {} }),
      /unknown tool|not found/i,
    );
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- gateway stderr ---\n${stderr}`);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});
