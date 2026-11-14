/**
 * Gateway configuration.
 *
 * A config is a map of alias -> server. Everything is optional except the
 * launch method (command+args or url), so a minimal entry stays minimal:
 *
 *   { "servers": { "fs": { "command": "npx", "args": ["-y", "...", "/src"] } } }
 *
 * Validation is hand-written so error messages can say which key is wrong and
 * what the fix is. Unknown keys are rejected rather than silently ignored: a
 * typo like `"mount"` instead of `"mounts"` would otherwise silently drop the
 * permission you thought you had removed.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DriverName } from "../sandbox/detect.js";
import type { MountSpec, NetworkMode, ResourceLimits } from "../sandbox/policy.js";

export interface MountedServerConfig {
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  mounts?: MountSpec[];
  network?: NetworkMode;
  persistentHome?: boolean;
  image?: string;
  runtimePrefixes?: string[];
  limits?: Partial<ResourceLimits>;
  allowPrivateNetwork?: boolean;
  /** Tool names that require explicit human approval before every call. */
  destructiveTools?: string[];
  enabled?: boolean;
}

export interface GatewaySettings {
  driver?: "auto" | DriverName;
  allowUnsandboxed?: boolean;
  host?: string;
  port?: number;
  token?: string;
}

export interface LoadedGatewayConfig {
  path: string | null;
  settings: GatewaySettings;
  servers: Record<string, MountedServerConfig>;
}

const SERVER_KEYS = new Set([
  "transport",
  "command",
  "args",
  "cwd",
  "url",
  "headers",
  "env",
  "mounts",
  "network",
  "persistentHome",
  "image",
  "runtimePrefixes",
  "limits",
  "allowPrivateNetwork",
  "destructiveTools",
  "enabled",
]);

const SETTINGS_KEYS = new Set(["driver", "allowUnsandboxed", "host", "port", "token"]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${where} must be an array of strings`);
  }
  return value as string[];
}

function stringMap(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new ConfigError(`${where}.${key} must be a string`);
    out[key] = item;
  }
  return out;
}


function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/, homedir());
}

function parseMounts(value: unknown, where: string): MountSpec[] {
  if (!Array.isArray(value)) throw new ConfigError(`${where} must be an array`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ConfigError(`${where}[${index}] must be an object`);
    const source = item.source;
    const target = item.target;
    const mode = item.mode ?? "ro";
    if (typeof source !== "string" || source.length === 0) {
      throw new ConfigError(`${where}[${index}].source must be a non-empty path`);
    }
    if (typeof target !== "string" || !target.startsWith("/")) {
      throw new ConfigError(`${where}[${index}].target must be an absolute path`);
    }
    if (mode !== "ro" && mode !== "rw") {
      throw new ConfigError(`${where}[${index}].mode must be "ro" or "rw"`);
    }
    return { source: resolve(expandHome(source)), target, mode };
  });
}

function parseLimits(value: unknown, where: string): Partial<ResourceLimits> {
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object`);
  const limits: Partial<ResourceLimits> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
      throw new ConfigError(`${where}.${key} must be a non-negative number`);
    }
    (limits as Record<string, number>)[key] = item;
  }
  return limits;
}

function parseServer(alias: string, value: unknown): MountedServerConfig {
  const where = `servers.${alias}`;
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object`);

  for (const key of Object.keys(value)) {
    if (!SERVER_KEYS.has(key)) {
      throw new ConfigError(
        `${where}.${key} is not a recognised option (expected: ${[...SERVER_KEYS].join(", ")})`,
      );
    }
  }

  const config: MountedServerConfig = {};

  if (value.transport !== undefined) {
    if (value.transport !== "stdio" && value.transport !== "http" && value.transport !== "sse") {
      throw new ConfigError(`${where}.transport must be "stdio", "http" or "sse"`);
    }
    config.transport = value.transport;
  }

  if (value.command !== undefined) {
    if (typeof value.command !== "string" || value.command.length === 0) {
      throw new ConfigError(`${where}.command must be a non-empty string`);
    }
    config.command = value.command;
  }
  if (value.args !== undefined) config.args = stringArray(value.args, `${where}.args`);
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string") throw new ConfigError(`${where}.cwd must be a string`);
    config.cwd = value.cwd;
  }
  if (value.url !== undefined) {
    if (typeof value.url !== "string") throw new ConfigError(`${where}.url must be a string`);
    config.url = value.url;
  }
  if (value.headers !== undefined) config.headers = stringMap(value.headers, `${where}.headers`);
  if (value.env !== undefined) config.env = stringMap(value.env, `${where}.env`);
  if (value.mounts !== undefined) config.mounts = parseMounts(value.mounts, `${where}.mounts`);
  if (value.network !== undefined) {
    if (value.network !== "none" && value.network !== "egress") {
      throw new ConfigError(`${where}.network must be "none" or "egress"`);
    }
    config.network = value.network;
  }
  if (value.persistentHome !== undefined) {
    if (typeof value.persistentHome !== "boolean") {
      throw new ConfigError(`${where}.persistentHome must be a boolean`);
    }
    config.persistentHome = value.persistentHome;
  }
  if (value.image !== undefined) {
    if (typeof value.image !== "string") throw new ConfigError(`${where}.image must be a string`);
    config.image = value.image;
  }
  if (value.runtimePrefixes !== undefined) {
    config.runtimePrefixes = stringArray(value.runtimePrefixes, `${where}.runtimePrefixes`);
  }
  if (value.limits !== undefined) config.limits = parseLimits(value.limits, `${where}.limits`);
  if (value.allowPrivateNetwork !== undefined) {
    if (typeof value.allowPrivateNetwork !== "boolean") {
      throw new ConfigError(`${where}.allowPrivateNetwork must be a boolean`);
    }
    config.allowPrivateNetwork = value.allowPrivateNetwork;
  }
  if (value.destructiveTools !== undefined) {
    config.destructiveTools = stringArray(value.destructiveTools, `${where}.destructiveTools`);
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new ConfigError(`${where}.enabled must be a boolean`);
    }
    config.enabled = value.enabled;
  }

  const transport = config.transport ?? (config.url && !config.command ? "http" : "stdio");

  if (transport === "stdio" && !config.command) {
    throw new ConfigError(`${where}: transport "stdio" requires "command"`);
  }
  if (transport !== "stdio" && !config.url) {
    throw new ConfigError(`${where}: transport "${transport}" requires "url"`);
  }

  return config;
}

export function parseGatewayConfig(raw: unknown, path: string | null = null): LoadedGatewayConfig {
  if (!isRecord(raw)) throw new ConfigError("config root must be an object");

  const settingsBlock = isRecord(raw.gateway) ? raw.gateway : raw;
  const settings: GatewaySettings = {};

  for (const [key, value] of Object.entries(settingsBlock)) {
    if (key === "servers") continue;
    if (!SETTINGS_KEYS.has(key)) {
      if (isRecord(raw.gateway)) throw new ConfigError(`gateway.${key} is not a recognised option`);
      continue;
    }

    if (key === "driver") {
      const allowed = ["auto", "bwrap", "docker", "podman", "unshare", "none"];
      if (typeof value !== "string" || !allowed.includes(value)) {
        throw new ConfigError(`gateway.driver must be one of ${allowed.join(", ")}`);
      }
      settings.driver = value as GatewaySettings["driver"];
    } else if (key === "allowUnsandboxed") {
      if (typeof value !== "boolean") throw new ConfigError("gateway.allowUnsandboxed must be a boolean");
      settings.allowUnsandboxed = value;
    } else if (key === "host") {
      if (typeof value !== "string") throw new ConfigError("gateway.host must be a string");
      settings.host = value;
    } else if (key === "port") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
        throw new ConfigError("gateway.port must be an integer between 1 and 65535");
      }
      settings.port = value;
    } else if (key === "token") {
      if (typeof value !== "string" || value.length < 16) {
        throw new ConfigError("gateway.token must be a string of at least 16 characters");
      }
      settings.token = value;
    }
  }

  const serversBlock = raw.servers ?? (isRecord(raw.gateway) ? raw.gateway.servers : undefined);
  const servers: Record<string, MountedServerConfig> = {};

  if (serversBlock !== undefined) {
    if (!isRecord(serversBlock)) throw new ConfigError("servers must be an object keyed by alias");
    for (const [alias, value] of Object.entries(serversBlock)) {
      if (!/^[a-zA-Z0-9._-]{1,40}$/.test(alias) || alias.includes("__")) {
        throw new ConfigError(
          `servers.${alias}: alias must match [a-zA-Z0-9._-], must not contain "__" ` +
            "(reserved as the namespace separator), and be at most 40 characters",
        );
      }
      servers[alias] = parseServer(alias, value);
    }
  }

  return { path, settings, servers };
}

export function defaultConfigPaths(): string[] {
  const home = process.env.MCP_INDEX_HOME ?? join(homedir(), ".local", "share", "mcp-index");
  return [join(process.cwd(), "mcp-index.json"), join(home, "config.json")];
}

export function loadGatewayConfig(explicitPath?: string): LoadedGatewayConfig {
  const path = explicitPath
    ? resolve(expandHome(explicitPath))
    : defaultConfigPaths().find((candidate) => existsSync(candidate));

  if (!path) return { path: null, settings: {}, servers: {} };
  if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseGatewayConfig(parsed, path);
}
