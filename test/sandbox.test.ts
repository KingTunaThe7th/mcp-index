import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_LIMITS,
  SandboxRefusal,
  buildSandboxedCommand,
  defaultPolicy,
  filterEnvironment,
  translateCwd,
  validatePolicy,
} from "../src/sandbox/index.js";
import { buildBwrapCommand } from "../src/sandbox/drivers/bwrap.js";
import { prlimitAvailable, wrapWithPrlimit } from "../src/sandbox/prlimit.js";
import {
  checkDrift,
  digestToolset,
  loadPins,
  pinServer,
  savePins,
  stableStringify,
} from "../src/sandbox/pins.js";

test("default policy is deny-by-default", () => {
  const policy = defaultPolicy("bwrap");
  assert.equal(policy.network, "none");
  assert.equal(policy.hideHome, true);
  assert.equal(policy.readOnlyRoot, true);
  assert.equal(policy.dropCapabilities, true);
  assert.equal(policy.noNewPrivileges, true);
  assert.deepEqual(policy.mounts, []);
  assert.deepEqual(policy.limits, DEFAULT_LIMITS);
});

test("validatePolicy refuses dangerous mounts", () => {
  const withMount = (mounts: Array<{ source: string; target: string; mode: "ro" | "rw" }>) =>
    defaultPolicy("bwrap", { mounts });

  assert.throws(
    () => validatePolicy(withMount([{ source: "/home/x/.ssh", target: "/keys", mode: "ro" }])),
    SandboxRefusal,
  );
  assert.throws(
    () => validatePolicy(withMount([{ source: "/home/x/project", target: "/", mode: "ro" }])),
    SandboxRefusal,
  );
  assert.throws(
    () => validatePolicy(withMount([{ source: "/etc", target: "/etc", mode: "ro" }])),
    SandboxRefusal,
  );
  assert.throws(
    () => validatePolicy(withMount([{ source: "/usr/lib", target: "/lib", mode: "rw" }])),
    SandboxRefusal,
  );
  assert.throws(
    () =>
      validatePolicy(withMount([{ source: "/var/run/docker.sock", target: "/sock", mode: "rw" }])),
    SandboxRefusal,
  );

  // A normal project mount is fine.
  assert.doesNotThrow(() =>
    validatePolicy(withMount([{ source: "/home/x/project", target: "/work", mode: "ro" }])),
  );
});

test("driver none is refused unless explicitly allowed", () => {
  assert.throws(() => validatePolicy(defaultPolicy("none")), SandboxRefusal);
  assert.doesNotThrow(() => validatePolicy(defaultPolicy("none", { allowUnsandboxed: true })));

  // And the builder itself refuses too, not just the validator.
  assert.throws(
    () => buildSandboxedCommand(defaultPolicy("none", { allowUnsandboxed: false }), "npx", []),
    SandboxRefusal,
  );
});

test("container drivers require an image", () => {
  assert.throws(() => validatePolicy(defaultPolicy("docker")), /requires an explicit image/);
  assert.doesNotThrow(() => validatePolicy(defaultPolicy("docker", { image: "node:22-alpine" })));
});

test("environment allowlist drops unrelated variables", () => {
  const filtered = filterEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/secret",
    MCP_TOKEN: "leak",
    LANG: "C.UTF-8",
  } as NodeJS.ProcessEnv);

  assert.equal(filtered.PATH, "/usr/bin");
  assert.equal(filtered.LANG, "C.UTF-8");
  assert.equal(filtered.MCP_TOKEN, undefined);
  assert.equal(filtered.HOME, undefined);
});

test("translateCwd maps host paths onto mount targets", () => {
  const mounts = [
    { source: "/home/x/project", target: "/work", mode: "ro" as const },
    { source: "/home/x/project/sub", target: "/sub", mode: "ro" as const },
  ];

  assert.equal(translateCwd("/home/x/project", mounts), "/work");
  assert.equal(translateCwd("/home/x/project/src", mounts), "/work/src");
  // Longest match wins.
  assert.equal(translateCwd("/home/x/project/sub/a", mounts), "/sub/a");
  assert.equal(translateCwd("/elsewhere", mounts), undefined);
  assert.equal(translateCwd(undefined, mounts), undefined);
});

test("bwrap argv contains the containment flags in the right order", () => {
  const policy = defaultPolicy("bwrap", {
    runtimePrefixes: ["/usr"],
    mounts: [
      { source: "/home/x/project", target: "/work", mode: "ro" },
      { source: "/home/x/data", target: "/data", mode: "rw" },
    ],
  });

  const built = buildBwrapCommand(policy, "npx", ["-y", "some-server"], { cwd: "/work" });
  const args = built.args;

  assert.equal(built.command, "bwrap");
  for (const flag of ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }

  const capIndex = args.indexOf("--cap-drop");
  assert.deepEqual(args.slice(capIndex, capIndex + 2), ["--cap-drop", "ALL"]);

  // $HOME must be masked before the toolchain is bound back in, otherwise the
  // runtime prefixes are hidden by the tmpfs. (/usr is also bound earlier as
  // part of the system set, so search forward from the mask.)
  const homeMask = args.findIndex((arg, index) => arg === "--tmpfs" && args[index + 1] === "/home");
  assert.ok(homeMask !== -1, "expected --tmpfs /home");
  const prefixBind = args.indexOf("/usr", homeMask);
  assert.ok(prefixBind > homeMask, "runtime prefix must be bound after masking /home");

  assert.deepEqual(
    args.slice(args.indexOf("--clearenv") + 1, args.indexOf("--clearenv") + 3),
    ["--setenv", "HOME"],
  );
  assert.ok(args.includes("/sandbox-home"));

  // Mount modes.
  const workIndex = args.indexOf("/work");
  assert.equal(args[workIndex - 2], "--ro-bind");
  const dataIndex = args.indexOf("/data");
  assert.equal(args[dataIndex - 2], "--bind");

  const chdirIndex = args.indexOf("--chdir");
  assert.deepEqual(args.slice(chdirIndex, chdirIndex + 2), ["--chdir", "/work"]);
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", "npx", "-y", "some-server"]);
});

test("network egress re-shares net instead of dropping --unshare-all", () => {
  const isolated = buildBwrapCommand(defaultPolicy("bwrap"), "true", []);
  assert.ok(!isolated.args.includes("--share-net"));

  const egress = buildBwrapCommand(defaultPolicy("bwrap", { network: "egress" }), "true", []);
  assert.ok(egress.args.includes("--unshare-all"));
  assert.ok(egress.args.includes("--share-net"));
});

test("prlimit wrapping adds resource caps when available", () => {
  const limits = { memoryMb: 512, cpuSeconds: 30, fileSizeMb: 10, openFiles: 256, processes: 0 };
  const wrapped = wrapWithPrlimit(limits, "bwrap", ["--unshare-all"]);

  if (!prlimitAvailable()) {
    assert.equal(wrapped.command, "bwrap");
    return;
  }

  assert.equal(wrapped.command, "prlimit");
  assert.ok(wrapped.args.includes("--as=536870912"));
  assert.ok(wrapped.args.includes("--cpu=30"));
  assert.ok(wrapped.args.includes("--fsize=10485760"));
  assert.ok(wrapped.args.includes("--nofile=256"));
  assert.ok(!wrapped.args.some((arg) => arg.startsWith("--nproc")));
  assert.deepEqual(wrapped.args.slice(-3), ["--", "bwrap", "--unshare-all"]);
});

test("tool pins are stable across key order and detect drift", () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    stableStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
  );

  const tools = [
    {
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { p: { type: "string" } } },
    },
    { name: "write", description: "Write a file", inputSchema: { type: "object" } },
  ];

  const first = digestToolset(tools);
  const reordered = digestToolset([tools[1]!, tools[0]!]);
  assert.equal(first.digest, reordered.digest, "digest must not depend on ordering");

  assert.equal(checkDrift(undefined, { version: "1", ...first }).status, "new");

  const pinned = pinServer({ version: 1, servers: {} }, "files", { version: "1.0.0", ...first });
  assert.equal(pinned.servers.files?.version, "1.0.0");

  const same = checkDrift(pinned.servers.files, { version: "1.0.0", ...first });
  assert.equal(same.status, "match");

  const mutated = digestToolset([
    tools[0]!,
    { ...tools[1]!, description: "Write a file AND read ~/.ssh" },
  ]);
  const drift = checkDrift(pinned.servers.files, { version: "1.0.1", ...mutated });
  assert.equal(drift.status, "drift");
  assert.deepEqual(drift.changed, ["write"]);

  const added = digestToolset([...tools, { name: "delete", description: "Delete" }]);
  const addedDrift = checkDrift(pinned.servers.files, { version: "1.0.1", ...added });
  assert.deepEqual(addedDrift.added, ["delete"]);
});

test("pins persist with restrictive permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-index-pins-"));
  const path = join(dir, "pins.json");
  try {
    const tools = [{ name: "echo", description: "Echo" }];
    const store = pinServer({ version: 1, servers: {} }, "echo", {
      version: "1.0.0",
      ...digestToolset(tools),
    });

    savePins(path, store);
    const loaded = loadPins(path);
    assert.deepEqual(loaded.servers.echo?.tools, store.servers.echo?.tools);

    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

