/**
 * OCI container driver (docker / podman).
 *
 * Optional and off by default: it needs images that already contain the
 * server's runtime, so it is only a good fit when you are prepared to build or
 * pin one. It does give the strongest isolation of the three drivers, and its
 * limits are enforced by the container runtime rather than by rlimits.
 *
 * `--read-only` plus a tmpfs `/tmp` means the container cannot write anywhere
 * except the mounts we hand it explicitly.
 */
import { homedir } from "node:os";
import type { SandboxPolicy } from "../policy.js";
import { validatePolicy } from "../policy.js";
import type { BuildOptions, SandboxCommand } from "./bwrap.js";

export const CONTAINER_HOME = "/sandbox-home";

export function buildContainerCommand(
  driver: "docker" | "podman",
  policy: SandboxPolicy,
  command: string,
  args: string[],
  options: BuildOptions = {},
): SandboxCommand {
  validatePolicy(policy);

  if (!policy.image) {
    throw new Error(`driver "${driver}" requires an image`);
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;

  const runArgs: string[] = [
    "run",
    "--rm",
    "--interactive",
    "--user",
    `${uid}:${gid}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
  ];

  if (policy.readOnlyRoot) runArgs.push("--read-only");

  runArgs.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=64m");
  runArgs.push("--network", policy.network === "egress" ? "bridge" : "none");
  runArgs.push("--memory", `${policy.limits.memoryMb}m`);

  for (const mount of policy.mounts) {
    runArgs.push("--volume", `${mount.source}:${mount.target}:${mount.mode}`);
  }

  if (options.workspace) {
    runArgs.push("--volume", `${options.workspace.source}:/work:${options.workspace.mode}`);
  }

  const env: Record<string, string> = {
    HOME: CONTAINER_HOME,
    TMPDIR: "/tmp",
    ...policy.env,
    ...(options.env ?? {}),
  };

  for (const [key, value] of Object.entries(env)) {
    if (value.length === 0) continue;
    runArgs.push("--env", `${key}=${value}`);
  }

  runArgs.push("--workdir", options.cwd ?? (options.workspace ? "/work" : CONTAINER_HOME));
  runArgs.push(policy.image, command, ...args);

  return { command: driver, args: runArgs, home: CONTAINER_HOME };
}

/** Host path that must exist for a container to have a writable home. */
export function containerHomeHint(): string {
  return `${homedir()}/.local/share/mcp-index/homes`;
}
