/**
 * Local MCP client configs as a source.
 *
 * This is how you find out what you already run. The critical detail is that
 * `env` blocks usually contain raw API keys, so only the *names* are imported
 * and the values are discarded at parse time -- never stored, never logged.
 */
import { existsSync, readFileSync } from "node:fs";
import { localConfigCandidates } from "../config.js";
import { redactEnvNames } from "../security/redact.js";
import type { RawServer, RemoteRef } from "../types.js";

export interface LocalEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface LocalConfig {
  path: string;
  servers: Record<string, LocalEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseLocalConfig(text: string, path: string): LocalConfig {
  const servers: Record<string, LocalEntry> = {};

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { path, servers };

    const block = isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : isRecord(parsed.servers)
        ? parsed.servers
        : {};

    for (const [alias, value] of Object.entries(block)) {
      if (!isRecord(value)) continue;
      const entry: LocalEntry = {};
      if (typeof value.command === "string") entry.command = value.command;
      if (Array.isArray(value.args)) entry.args = value.args.filter((a): a is string => typeof a === "string");
      if (isRecord(value.env)) {
        entry.env = {};
        for (const [key, val] of Object.entries(value.env)) {
          if (typeof val === "string") entry.env[key] = val;
        }
      }
      if (typeof value.url === "string") entry.url = value.url;
      if (typeof value.type === "string") entry.type = value.type;
      if (isRecord(value.headers)) {
        entry.headers = {};
        for (const [key, val] of Object.entries(value.headers)) {
          if (typeof val === "string") entry.headers[key] = val;
        }
      }
      if (value.disabled === true) entry.disabled = true;
      servers[alias] = entry;
    }
  } catch {
    // A malformed client config should not abort a sync.
  }

  return { path, servers };
}

export function readLocalConfigs(paths: string[] = localConfigCandidates()): LocalConfig[] {
  const found: LocalConfig[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const config = parseLocalConfig(readFileSync(path, "utf8"), path);
      if (Object.keys(config.servers).length > 0) found.push(config);
    } catch {
      // Unreadable file: skip.
    }
  }
  return found;
}

export function localEntryToRaw(alias: string, entry: LocalEntry, configPath: string): RawServer {
  const remotes: RemoteRef[] = entry.url
    ? [
        {
          type: entry.type ?? "streamable-http",
          url: entry.url,
          ...(entry.headers ? { headerNames: Object.keys(entry.headers).sort() } : {}),
        },
      ]
    : [];

  return {
    source: "local",
    id: `local:${alias}`,
    name: alias,
    description: entry.command
      ? `Configured locally in ${configPath}`
      : `Remote server configured locally in ${configPath}`,
    remotes,
    command: entry.command ?? null,
    args: entry.args ?? [],
    envNames: redactEnvNames(entry.env),
    isOfficial: false,
    raw: {
      configPath,
      command: entry.command ?? null,
      args: entry.args ?? [],
      // Names only. Values are intentionally dropped here.
      envNames: redactEnvNames(entry.env),
      url: entry.url ?? null,
    },
  };
}

export function localServersToRaw(configs: LocalConfig[]): RawServer[] {
  const out: RawServer[] = [];
  for (const config of configs) {
    for (const [alias, entry] of Object.entries(config.servers)) {
      if (entry.disabled) continue;
      out.push(localEntryToRaw(alias, entry, config.path));
    }
  }
  return out;
}
