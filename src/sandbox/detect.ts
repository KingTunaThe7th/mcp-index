/**
 * Sandbox driver discovery.
 *
 * There is no single portable answer, so we probe and report rather than
 * assume. The important property is that `auto` never silently degrades to an
 * unsandboxed spawn: if nothing is available the gateway refuses to start.
 *
 * Verified behaviour on the reference host (Linux Mint 22.3 / kernel 7.0):
 *   - bubblewrap works unprivileged and enforces mount + network + capability
 *     isolation, so it is the preferred driver.
 *   - `systemd-run --user --scope` rejects ProtectHome, ProtectSystem,
 *     NoNewPrivileges and PrivateTmp ("Unknown assignment"), because those are
 *     system-unit-only properties. It is therefore NOT usable as a rootless
 *     sandbox driver and is reported as unsupported.
 *   - `unshare -rn` alone isolates the network namespace but touches nothing
 *     else, so it is a network-only fallback.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export type DriverName = "bwrap" | "docker" | "podman" | "unshare" | "none";

export interface Capabilities {
  bwrap: boolean;
  bwrapVersion: string | null;
  docker: boolean;
  podman: boolean;
  unshare: boolean;
  /** Linux user namespaces permitted for this user. */
  userNamespaces: boolean;
  platform: NodeJS.Platform;
  /** True when the driver can contain the filesystem, not just the network. */
  filesystemIsolation: boolean;
}

function probe(command: string, args: string[], timeoutMs = 4_000): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

function readSysctl(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

export function detectCapabilities(): Capabilities {
  const platform = process.platform;
  const bwrapVersion = platform === "linux" ? probe("bwrap", ["--version"]) : null;
  const dockerVersion = probe("docker", ["--version"]);
  const podmanVersion = probe("podman", ["--version"]);
  const unshareOk = platform === "linux" ? probe("unshare", ["-rn", "true"]) !== null : false;

  // Ubuntu 24.04+ can restrict unprivileged user namespaces via AppArmor.
  const apparmorRestricted = readSysctl("/proc/sys/kernel/apparmor_restrict_unprivileged_userns");
  const usernsClone = readSysctl("/proc/sys/kernel/unprivileged_userns_clone");
  const userNamespaces =
    platform === "linux" && apparmorRestricted !== "1" && usernsClone !== "0";

  const bwrap = bwrapVersion !== null && userNamespaces;

  return {
    bwrap,
    bwrapVersion,
    docker: dockerVersion !== null,
    podman: podmanVersion !== null,
    unshare: unshareOk,
    userNamespaces,
    platform,
    filesystemIsolation: bwrap || dockerVersion !== null || podmanVersion !== null,
  };
}

export interface DriverSelection {
  driver: DriverName;
  reason: string;
}

export function selectDriver(
  preference: "auto" | DriverName,
  capabilities: Capabilities = detectCapabilities(),
): DriverSelection {
  if (preference !== "auto") {
    const available =
      (preference === "bwrap" && capabilities.bwrap) ||
      (preference === "docker" && capabilities.docker) ||
      (preference === "podman" && capabilities.podman) ||
      (preference === "unshare" && capabilities.unshare) ||
      preference === "none";

    if (!available) {
      throw new Error(
        `requested sandbox driver "${preference}" is not available on this host`,
      );
    }
    return { driver: preference, reason: "explicitly configured" };
  }

  if (capabilities.bwrap) {
    return { driver: "bwrap", reason: "bubblewrap available (mount + net + caps)" };
  }
  if (capabilities.docker) {
    return { driver: "docker", reason: "docker available" };
  }
  if (capabilities.podman) {
    return { driver: "podman", reason: "podman available" };
  }
  if (capabilities.unshare) {
    return {
      driver: "unshare",
      reason: "network-namespace isolation only; filesystem NOT contained",
    };
  }
  return { driver: "none", reason: "no sandbox mechanism detected" };
}

/**
 * Runtime prefixes that must stay visible inside the sandbox even though
 * `$HOME` is masked. The reference host installs Node under
 * `~/.local/node22`, so hiding all of `$HOME` would break `npx` entirely.
 */
export function discoverRuntimePrefixes(): string[] {
  const home = homedir();
  const candidates = [
    `${home}/.local/node22`,
    `${home}/.nvm`,
    `${home}/.local/share/mise`,
    `${home}/.volta`,
    `${home}/.pyenv`,
    `${home}/.local/share/uv`,
    `${home}/.cargo`,
    `${home}/.bun`,
  ];
  return candidates.filter((candidate) => existsSync(candidate));
}

/** Node's own install prefix, used as a last resort. */
export function nodePrefix(): string {
  const execPath = process.execPath;
  const index = execPath.lastIndexOf("/bin/");
  return index === -1 ? "" : execPath.slice(0, index);
}
