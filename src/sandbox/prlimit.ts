/**
 * Resource caps via `prlimit(1)`.
 *
 * bwrap and unshare do not enforce CPU/memory/file limits, so a mounted server
 * can otherwise fork-bomb or exhaust RAM and take the gateway down with it.
 * `prlimit` is part of util-linux and is present on every mainstream Linux.
 *
 * RLIMIT_NPROC is per-UID, not per-process-tree, so it is disabled by default:
 * a low value counts the *user's* existing processes and can make an otherwise
 * healthy child fail to fork.
 */
import { spawnSync } from "node:child_process";
import type { ResourceLimits } from "./policy.js";

let available: boolean | null = null;

export function prlimitAvailable(): boolean {
  if (available !== null) return available;
  const result = spawnSync("prlimit", ["--version"], { stdio: "ignore", timeout: 3_000 });
  available = !result.error && result.status === 0;
  return available;
}

export interface LimitedCommand {
  command: string;
  args: string[];
  applied: string[];
}

export function wrapWithPrlimit(
  limits: ResourceLimits,
  command: string,
  args: string[],
): LimitedCommand {
  if (!prlimitAvailable()) {
    return { command, args, applied: [] };
  }

  const flags: string[] = [];
  const applied: string[] = [];

  if (limits.memoryMb > 0) {
    flags.push(`--as=${limits.memoryMb * 1024 * 1024}`);
    applied.push(`as=${limits.memoryMb}MiB`);
  }
  if (limits.cpuSeconds > 0) {
    flags.push(`--cpu=${limits.cpuSeconds}`);
    applied.push(`cpu=${limits.cpuSeconds}s`);
  }
  if (limits.fileSizeMb > 0) {
    flags.push(`--fsize=${limits.fileSizeMb * 1024 * 1024}`);
    applied.push(`fsize=${limits.fileSizeMb}MiB`);
  }
  if (limits.openFiles > 0) {
    flags.push(`--nofile=${limits.openFiles}`);
    applied.push(`nofile=${limits.openFiles}`);
  }
  if (limits.processes > 0) {
    flags.push(`--nproc=${limits.processes}`);
    applied.push(`nproc=${limits.processes}`);
  }

  if (flags.length === 0) return { command, args, applied };

  return {
    command: "prlimit",
    args: [...flags, "--", command, ...args],
    applied,
  };
}
