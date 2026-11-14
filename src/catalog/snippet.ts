/**
 * Client config snippets.
 *
 * `mcp-index search` is only half the job; the other half is getting a server
 * into a client without hand-copying JSON. Snippets are generated from the
 * normalized record so they never include a secret: remote headers are emitted
 * as placeholders for you to fill in.
 */
import type { InstallSnippet, ServerRecord } from "../types.js";

export type ClientKind = "claude" | "cursor" | "vscode" | "generic";

export function entryAlias(record: ServerRecord): string {
  const base = record.id
    .replace(/^github:/, "")
    .replace(/^local:/, "")
    .replace(/^name:/, "")
    .split("/")
    .pop();

  return (base ?? record.name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48) || "server";
}

function localLaunch(record: ServerRecord): { command: string; args: string[] } | null {
  const snippet: InstallSnippet | undefined =
    record.install.find((entry) => entry.kind === "npx") ??
    record.install.find((entry) => entry.kind === "uvx") ??
    record.install.find((entry) => entry.kind === "docker") ??
    record.install.find((entry) => entry.kind === "command");

  if (!snippet?.command) return null;
  return { command: snippet.command, args: snippet.args ?? [] };
}

function remoteUrl(record: ServerRecord): string | null {
  return record.remotes[0]?.url ?? record.install.find((entry) => entry.kind === "remote")?.url ?? null;
}

export function buildClientConfig(
  record: ServerRecord,
  client: ClientKind = "claude",
  alias = entryAlias(record),
): unknown {
  const launch = localLaunch(record);
  const url = remoteUrl(record);

  if (url) {
    if (client === "vscode") {
      return { servers: { [alias]: { type: "http", url } } };
    }
    if (client === "generic") {
      return { name: alias, transport: "http", url };
    }
    return { mcpServers: { [alias]: { url } } };
  }

  if (!launch) {
    return { error: "no launch method recorded for this server" };
  }

  if (client === "vscode") {
    return { servers: { [alias]: { type: "stdio", command: launch.command, args: launch.args } } };
  }
  if (client === "generic") {
    return { name: alias, transport: "stdio", command: launch.command, args: launch.args };
  }
  return { mcpServers: { [alias]: { command: launch.command, args: launch.args } } };
}

/** One-line, copy-pasteable launch command. */
export function formatLaunch(record: ServerRecord): string {
  const launch = localLaunch(record);
  if (launch) {
    return [launch.command, ...launch.args]
      .map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part))
      .join(" ");
  }
  const url = remoteUrl(record);
  if (url) return `remote: ${url}`;
  return "no launch method recorded";
}

export function clientFromString(value: string): ClientKind {
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude" || normalized === "cursor") return normalized;
  if (normalized === "vscode" || normalized === "code") return "vscode";
  return "generic";
}
