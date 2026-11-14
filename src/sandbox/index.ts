/**
 * Sandbox entry point.
 *
 * `buildSandboxedCommand` is the only place a third-party process is turned
 * into an argv. It dispatches to a driver, applies rlimits, and returns an
 * environment that is already stripped down to the allowlist.
 */
import { existsSync } from "node:fs";
import { detectCapabilities, discoverRuntimePrefixes } from "./detect.js";
import type { Capabilities, DriverName } from "./detect.js";
import { buildBwrapCommand } from "./drivers/bwrap.js";
import type { BuildOptions, SandboxCommand } from "./drivers/bwrap.js";
import { buildContainerCommand } from "./drivers/container.js";
import { buildUnsandboxedCommand, unsandboxedEnvironment } from "./drivers/none.js";
import { buildUnshareCommand } from "./drivers/unshare.js";
import type { SandboxPolicy } from "./policy.js";
import { SandboxRefusal, filterEnvironment, validatePolicy } from "./policy.js";
import { prlimitAvailable, wrapWithPrlimit } from "./prlimit.js";

export * from "./detect.js";
export * from "./policy.js";
export * from "./pins.js";
export * from "./prlimit.js";
export { buildBwrapCommand } from "./drivers/bwrap.js";
export type { BuildOptions, SandboxCommand } from "./drivers/bwrap.js";
export { buildContainerCommand } from "./drivers/container.js";
export { buildUnshareCommand } from "./drivers/unshare.js";
export { buildUnsandboxedCommand } from "./drivers/none.js";

export interface SandboxedCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  driver: DriverName;
  /** Human-readable note about what the driver actually contains. */
  containment: string;
  limitsApplied: string[];
}

const CONTAINMENT: Record<DriverName, string> = {
  bwrap: "filesystem + PID + network + capabilities isolated",
  docker: "container: filesystem + network isolated",
  podman: "container: filesystem + network isolated",
  unshare: "network isolated; filesystem NOT isolated",
  none: "NO isolation (allow-unsandboxed)",
};

/**
 * Fill in runtime prefixes when the caller did not supply any. Without this,
 * hiding `$HOME` breaks `npx` on hosts where Node lives under `~/.local`.
 */
export function withRuntimePrefixes(policy: SandboxPolicy): SandboxPolicy {
  if (policy.runtimePrefixes.length > 0) return policy;
  const discovered = discoverRuntimePrefixes().filter((prefix) => existsSync(prefix));
  const nodePrefix = (() => {
    const index = process.execPath.lastIndexOf("/bin/");
    return index === -1 ? "" : process.execPath.slice(0, index);
  })();

  const prefixes = Array.from(new Set([...discovered, nodePrefix].filter(Boolean)));
  return { ...policy, runtimePrefixes: prefixes };
}

export function buildSandboxedCommand(
  policy: SandboxPolicy,
  command: string,
  args: string[],
  options: BuildOptions = {},
): SandboxedCommand {
  const effective = withRuntimePrefixes(policy);
  validatePolicy(effective);

  let built: SandboxCommand;
  switch (effective.driver) {
    case "bwrap":
      built = buildBwrapCommand(effective, command, args, options);
      break;
    case "docker":
    case "podman":
      built = buildContainerCommand(effective.driver, effective, command, args, options);
      break;
    case "unshare":
      built = buildUnshareCommand(effective, command, args, options);
      break;
    case "none":
      built = buildUnsandboxedCommand(effective, command, args, options);
      break;
    default:
      throw new SandboxRefusal(`unknown driver: ${String(effective.driver)}`);
  }

  const env =
    effective.driver === "none"
      ? unsandboxedEnvironment(effective, options)
      : { ...filterEnvironment(process.env), ...effective.env, ...(options.env ?? {}) };

  let finalCommand = built.command;
  let finalArgs = built.args;
  let limitsApplied: string[] = [];

  if (effective.driver !== "docker" && effective.driver !== "podman") {
    const limited = wrapWithPrlimit(effective.limits, finalCommand, finalArgs);
    finalCommand = limited.command;
    finalArgs = limited.args;
    limitsApplied = limited.applied;
  }

  return {
    command: finalCommand,
    args: finalArgs,
    env,
    driver: effective.driver,
    containment: CONTAINMENT[effective.driver],
    limitsApplied,
  };
}

export interface DoctorReport {
  capabilities: Capabilities;
  prlimit: boolean;
  runtimePrefixes: string[];
  recommended: DriverName;
  warnings: string[];
}

export function doctor(): DoctorReport {
  const capabilities = detectCapabilities();
  const warnings: string[] = [];

  if (!capabilities.bwrap) {
    warnings.push(
      "bubblewrap not usable: mounts and $HOME cannot be isolated for stdio servers",
    );
  }
  if (capabilities.bwrap && !prlimitAvailable()) {
    warnings.push("prlimit missing: CPU/memory caps are not enforced");
  }
  if (capabilities.platform !== "linux") {
    warnings.push(
      `platform ${capabilities.platform}: only the container driver can provide isolation`,
    );
  }
  if (!capabilities.filesystemIsolation) {
    warnings.push("no driver can isolate the filesystem on this host");
  }

  const runtimePrefixes = discoverRuntimePrefixes();
  const recommended: DriverName = capabilities.bwrap
    ? "bwrap"
    : capabilities.docker
      ? "docker"
      : capabilities.podman
        ? "podman"
        : capabilities.unshare
          ? "unshare"
          : "none";

  return { capabilities, prlimit: prlimitAvailable(), runtimePrefixes, recommended, warnings };
}
