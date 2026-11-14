import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

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
