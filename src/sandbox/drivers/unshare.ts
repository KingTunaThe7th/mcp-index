/**
 * Network-only fallback: `unshare -rn`.
 *
 * This creates a user+network namespace, so the child has no connectivity
 * (loopback only) and cannot reach the host network. It does NOT change the
 * mount namespace, so the child still sees the entire host filesystem and
 * `$HOME`, including `~/.ssh` and browser profiles.
 *
 * It exists because it works on almost every Linux box without extra packages,
 * and because "no network exfiltration" is still a meaningful reduction. The
 * gateway labels it accordingly and refuses to imply it is a container.
 */
import type { SandboxPolicy } from "../policy.js";
import { validatePolicy } from "../policy.js";
import type { BuildOptions, SandboxCommand } from "./bwrap.js";

export function buildUnshareCommand(
  policy: SandboxPolicy,
  command: string,
  args: string[],
  options: BuildOptions = {},
): SandboxCommand {
  validatePolicy(policy);

  if (policy.network === "egress") {
    throw new Error(
      "driver \"unshare\" only provides network isolation; it cannot grant egress selectively",
    );
  }

  const unshareArgs = ["--user", "--map-root-user", "--net", "--fork", "--"];

  const cwd = options.cwd ?? options.workspace?.source;
  const finalArgs = [...unshareArgs, command, ...args];

  return {
    command: "unshare",
    args: finalArgs,
    home: policy.hideHome ? "/nonexistent" : (cwd ?? ""),
  };
}
