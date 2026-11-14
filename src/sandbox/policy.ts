/**
 * Sandbox policy: what a mounted server is allowed to touch.
 *
 * The threat model is "npm package published by a stranger, run because a
 * search result looked plausible". Assume it is hostile: it will try to read
 * `~/.ssh`, exfiltrate over the network, spawn a daemon, and persist.
 *
 * Defaults are therefore deny-by-default:
 *   - host filesystem read-only, `$HOME` replaced by an empty tmpfs
 *   - no network unless the server declares it needs egress
 *   - all capabilities dropped, no new privileges
 *   - no inherited environment (only an allowlist is forwarded)
 *
 * `validatePolicy` re-checks every mount at build time: a policy that would
 * expose secrets is a hard error, not a warning.
 */
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { DriverName } from "./detect.js";

export type NetworkMode = "none" | "egress";

export interface MountSpec {
  /** Host path. */
  source: string;
  /** Absolute path inside the sandbox. */
  target: string;
  mode: "ro" | "rw";
}

export interface ResourceLimits {
  memoryMb: number;
  cpuSeconds: number;
  fileSizeMb: number;
  openFiles: number;
  /** 0 disables RLIMIT_NPROC (it is per-UID and easy to mis-set). */
  processes: number;
}

export interface SandboxPolicy {
  driver: DriverName;
  network: NetworkMode;
  readOnlyRoot: boolean;
  dropCapabilities: boolean;
  noNewPrivileges: boolean;
  /** Replace the real home directory with an empty one. */
  hideHome: boolean;
  /** Keep the sandbox home across runs (only when the server needs state). */
  persistentHome: boolean;
  mounts: MountSpec[];
  /** Toolchain roots to keep visible inside the masked home. */
  runtimePrefixes: string[];
  /** Extra non-secret environment for the child. */
  env: Record<string, string>;
  limits: ResourceLimits;
  /** OCI image for the container drivers. */
  image?: string;
  /** Escape hatch: permit running with no isolation at all. */
  allowUnsandboxed?: boolean;
}

export class SandboxRefusal extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`sandbox policy refused: ${detail}`);
    this.name = "SandboxRefusal";
    this.detail = detail;
  }
}

export const DEFAULT_LIMITS: ResourceLimits = {
  memoryMb: 2048,
  cpuSeconds: 600,
  fileSizeMb: 256,
  openFiles: 4096,
  processes: 0,
};

/** Paths that must never be mounted into a sandbox, at any depth. */
const FORBIDDEN_SOURCE_PATTERNS = [
  /\/\.ssh(\/|$)/,
  /\/\.gnupg(\/|$)/,
  /\/\.aws(\/|$)/,
  /\/\.azure(\/|$)/,
  /\/\.kube(\/|$)/,
  /\/\.docker\/config\.json$/,
  /\/\.git-credentials$/,
  /\/\.netrc$/,
  /\/\.npmrc$/,
  /\/\.pypirc$/,
  /\/\.config\/gh(\/|$)/,
  /\/\.config\/gcloud(\/|$)/,
  /\/\.local\/share\/keyrings(\/|$)/,
  /\/etc\/shadow$/,
  /\/etc\/sudoers(\.d)?(\/|$)/,
  /docker\.sock$/,
  /\/\.password-store(\/|$)/,
];

/** Directories whose *entire* contents are too broad to expose. */
const FORBIDDEN_EXACT_SOURCES = new Set([
  "/",
  "/etc",
  "/home",
  "/root",
  "/usr",
  "/var",
  "/proc",
  "/sys",
  "/dev",
]);

const FORBIDDEN_TARGETS = new Set([
  "/",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
]);

export function defaultPolicy(
  driver: DriverName,
  overrides: Partial<SandboxPolicy> = {},
): SandboxPolicy {
  return {
    driver,
    network: "none",
    readOnlyRoot: true,
    dropCapabilities: true,
    noNewPrivileges: true,
    hideHome: true,
    persistentHome: false,
    mounts: [],
    runtimePrefixes: [],
    env: {},
    limits: { ...DEFAULT_LIMITS, ...(overrides.limits ?? {}) },
    allowUnsandboxed: false,
    ...overrides,
  };
}

function normalize(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) return trimmed;
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

export function validatePolicy(policy: SandboxPolicy): void {
  if (policy.driver === "none" && policy.allowUnsandboxed !== true) {
    throw new SandboxRefusal(
      "no sandbox driver is active and allowUnsandboxed is false; " +
        "install bubblewrap, or pass --allow-unsandboxed to accept full host access",
    );
  }

  const home = normalize(homedir());

  for (const mount of policy.mounts) {
    if (mount.source.trim().length === 0) {
      throw new SandboxRefusal("mount with empty source");
    }

    const source = normalize(resolvePath(mount.source));
    const target = normalize(mount.target);

    if (!target.startsWith("/")) {
      throw new SandboxRefusal(`mount target must be absolute: ${target}`);
    }

    if (FORBIDDEN_TARGETS.has(target)) {
      throw new SandboxRefusal(`refusing to mount over ${target}`);
    }

    if (FORBIDDEN_EXACT_SOURCES.has(source)) {
      throw new SandboxRefusal(`refusing to mount ${source} wholesale`);
    }

    if (source === home) {
      throw new SandboxRefusal("refusing to mount the entire home directory");
    }

    for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
      if (pattern.test(source)) {
        throw new SandboxRefusal(`refusing to mount secret-bearing path ${source}`);
      }
    }

    if (mount.mode === "rw" && (source.startsWith("/usr") || source.startsWith("/etc"))) {
      throw new SandboxRefusal(`refusing read-write mount of system path ${source}`);
    }
  }

  for (const prefix of policy.runtimePrefixes) {
    if (!prefix.startsWith("/")) {
      throw new SandboxRefusal(`runtime prefix must be absolute: ${prefix}`);
    }
  }

  if ((policy.driver === "docker" || policy.driver === "podman") && !policy.image) {
    throw new SandboxRefusal(`driver "${policy.driver}" requires an explicit image`);
  }

  if (policy.network !== "none" && policy.network !== "egress") {
    throw new SandboxRefusal(`unknown network mode: ${String(policy.network)}`);
  }
}

/**
 * Environment forwarded to children. Only these names survive; everything else
 * (API keys, cloud credentials, SSH agent sockets) is dropped by `--clearenv`.
 */
export const ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export function filterEnvironment(
  source: NodeJS.ProcessEnv,
  allowlist: string[] = ENV_ALLOWLIST,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowlist) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}
