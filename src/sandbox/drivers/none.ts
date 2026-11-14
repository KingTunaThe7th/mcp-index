/**
 * The "no isolation" driver.
 *
 * It is only reachable when the operator passes `--allow-unsandboxed`, and it
 * still applies the environment allowlist so a mounted server at least does not
 * inherit every API key in your shell.
 *
 * `validatePolicy` rejects this driver otherwise, which is what makes the
 * gateway fail closed on hosts without bubblewrap.
 */
import { homedir } from "node:os";
import type { SandboxPolicy } from "../policy.js";
import { SandboxRefusal, filterEnvironment, validatePolicy } from "../policy.js";
import type { BuildOptions, SandboxCommand } from "./bwrap.js";

export function buildUnsandboxedCommand(
  policy: SandboxPolicy,
  command: string,
  args: string[],
  options: BuildOptions = {},
): SandboxCommand {
  if (!policy.allowUnsandboxed) {
    throw new SandboxRefusal(
      "driver \"none\" requires allowUnsandboxed; refusing to run a third-party server with full host access",
    );
  }

  validatePolicy(policy);

  return {
    command,
    args,
    home: options.stateDir ?? homedir(),
  };
}

/** Environment for the unsandboxed case: allowlist only, never `process.env`. */
export function unsandboxedEnvironment(
  policy: SandboxPolicy,
  options: BuildOptions = {},
): Record<string, string> {
  return {
    ...filterEnvironment(process.env),
    ...policy.env,
    ...(options.env ?? {}),
  };
}
