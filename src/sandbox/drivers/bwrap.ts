/**
 * bubblewrap driver.
 *
 * Chosen because it is the only unprivileged mechanism on the reference host
 * that constrains the filesystem *and* the network *and* capabilities.
 *
 * Ordering rules that matter:
 *   - `--tmpfs /home` must come BEFORE the runtime-prefix binds, otherwise the
 *     toolchain (often installed under `$HOME`, e.g. ~/.local/node22) is hidden
 *     and `npx` cannot start.
 *   - `--unshare-all` includes the network namespace, so egress is re-granted
 *     with `--share-net` rather than by dropping `--unshare-all`.
 *   - `--clearenv` follows `--unshare-all`; every variable we want must be set
 *     explicitly afterwards.
 */
import { existsSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter } from "node:path";
import type { SandboxPolicy } from "../policy.js";
import { validatePolicy } from "../policy.js";

export interface SandboxCommand {
  command: string;
  args: string[];
  /** Absolute path of the sandbox home (created by bwrap). */
  home: string;
}

export interface BuildOptions {
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Extra env for this invocation (merged over policy.env). */
  env?: Record<string, string>;
  /** Host directory bound at /work (read-write only if policy allows). */
  workspace?: { source: string; mode: "ro" | "rw" };
  /** Persistent per-server state directory, bound at the sandbox home. */
  stateDir?: string;
}

export const SANDBOX_HOME = "/sandbox-home";

function systemBinds(networkEgress: boolean): string[] {
  const args: string[] = [];
  const readOnly = [
    "/usr",
    "/opt",
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/pki",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/passwd",
    "/etc/group",
    "/etc/nsswitch.conf",
    "/etc/localtime",
    "/etc/hosts",
    "/etc/services",
  ];

  if (networkEgress) readOnly.push("/etc/resolv.conf");

  for (const path of readOnly) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  return args;
}

/**
 * Debian-family hosts ship `/bin -> usr/bin`, `/lib -> usr/lib`. Because only
 * `/usr` is bound, the compatibility symlinks have to be recreated or every
 * `#!/bin/sh` script in the sandbox fails.
 */
function compatSymlinks(): string[] {
  const args: string[] = [];
  const pairs: Array<[string, string]> = [
    ["/bin", "usr/bin"],
    ["/sbin", "usr/sbin"],
    ["/lib", "usr/lib"],
    ["/lib64", "usr/lib64"],
    ["/lib32", "usr/lib32"],
  ];

  for (const [link, expected] of pairs) {
    if (!existsSync(link)) continue;
    let target: string;
    try {
      target = readlinkSync(link);
    } catch {
      continue;
    }
    if (target.replace(/^\//, "") === expected) {
      args.push("--symlink", expected, link);
    }
  }
  return args;
}

function buildPath(policy: SandboxPolicy): string {
  const parts: string[] = [];
  for (const prefix of policy.runtimePrefixes) parts.push(`${prefix}/bin`);
  parts.push("/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin");
  return Array.from(new Set(parts)).join(delimiter);
}

export function buildBwrapCommand(
  policy: SandboxPolicy,
  command: string,
  args: string[],
  options: BuildOptions = {},
): SandboxCommand {
  validatePolicy(policy);

  const home = SANDBOX_HOME;
  const bwrapArgs: string[] = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
  ];

  if (policy.network === "egress") bwrapArgs.push("--share-net");

  if (policy.dropCapabilities) bwrapArgs.push("--cap-drop", "ALL");

  bwrapArgs.push(...systemBinds(policy.network === "egress"));
  bwrapArgs.push(...compatSymlinks());

  if (policy.hideHome) {
    bwrapArgs.push("--tmpfs", "/home");
    for (const prefix of policy.runtimePrefixes) {
      if (existsSync(prefix)) bwrapArgs.push("--ro-bind", prefix, prefix);
    }
  } else {
    const realHome = homedir();
    if (existsSync(realHome)) bwrapArgs.push("--ro-bind", realHome, "/home/real");
  }

  if (policy.persistentHome && options.stateDir) {
    bwrapArgs.push("--bind", options.stateDir, home);
  } else {
    bwrapArgs.push("--dir", home);
  }

  bwrapArgs.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");

  for (const mount of policy.mounts) {
    const flag = mount.mode === "rw" ? "--bind" : "--ro-bind";
    bwrapArgs.push(flag, mount.source, mount.target);
  }

  if (options.workspace) {
    const flag = options.workspace.mode === "rw" ? "--bind" : "--ro-bind";
    bwrapArgs.push(flag, options.workspace.source, "/work");
  }

  bwrapArgs.push("--clearenv");

  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: "/tmp",
    PATH: buildPath(policy),
    TERM: "dumb",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...policy.env,
    ...(options.env ?? {}),
  };

  // npm/uv write caches under HOME; keep them inside the sandbox.
  env.npm_config_cache ??= `${home}/.npm`;
  env.XDG_CACHE_HOME ??= `${home}/.cache`;
  env.XDG_CONFIG_HOME ??= `${home}/.config`;

  for (const [key, value] of Object.entries(env)) {
    if (value.length === 0) continue;
    bwrapArgs.push("--setenv", key, value);
  }

  const cwd = options.cwd ?? (options.workspace ? "/work" : home);
  bwrapArgs.push("--chdir", cwd);
  bwrapArgs.push("--", command, ...args);

  return { command: "bwrap", args: bwrapArgs, home };
}
