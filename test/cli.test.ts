import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseGatewayConfig } from "../src/gateway/config.js";

const projectRoot = resolve(import.meta.dirname, "..");
const cli = join(projectRoot, "dist", "cli.js");

test("--help exits cleanly and lists every command", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: mcp-index/);
  for (const command of ["sync", "search", "snippet", "doctor", "gateway", "serve", "pin"]) {
    assert.match(result.stdout, new RegExp(command));
  }
});

test("a missing index is reported as a usage problem", () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-index-empty-"));
  try {
    const result = spawnSync(process.execPath, [cli, "stats"], {
      encoding: "utf8",
      env: { ...process.env, MCP_INDEX_HOME: home },
    });

    assert.equal(result.status, 2, "usage problems exit 2");
    assert.match(result.stderr, /no index at .*run `mcp-index sync` first/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("init writes a config that is internally consistent", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-index-init-"));
  try {
    const result = spawnSync(process.execPath, [cli, "init"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const config = parseGatewayConfig(JSON.parse(readFileSync(join(dir, "mcp-index.json"), "utf8")));
    const files = config.servers.files;
    assert.ok(files);

    // The launch args must use the sandbox path, not the host path: a host path
    // does not exist inside the sandbox and the server would fail to start.
    assert.ok(files.args?.includes("/work"), "args should reference the mount target");
    assert.equal(files.mounts?.[0]?.target, "/work");

    // npx cannot download inside a network-isolated sandbox.
    assert.equal(files.network, "egress");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a closed stdout pipe does not crash the CLI", { skip: process.platform === "win32" }, () => {
  // `| head -1` closes the pipe while doctor is still writing.
  const result = spawnSync(
    "/bin/sh",
    ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} doctor | head -1`],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!/EPIPE/.test(result.stderr), `stderr should not mention EPIPE:\n${result.stderr}`);
});
