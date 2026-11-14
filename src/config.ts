/**
 * Paths and upstream endpoints.
 *
 * Everything lives under one XDG-style root so `MCP_INDEX_HOME=.mcp-index`
 * gives a fully self-contained, gitignored working directory.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function homeDir(): string {
  return process.env.MCP_INDEX_HOME ?? join(homedir(), ".local", "share", "mcp-index");
}

export function indexPath(): string {
  return process.env.MCP_INDEX_DB ?? join(homeDir(), "index.db");
}

export function pinsPath(): string {
  return join(homeDir(), "pins.json");
}

export function stateDir(): string {
  return join(homeDir(), "state");
}

export function cacheDir(): string {
  return join(homeDir(), "cache");
}

export function homesDir(): string {
  return join(homeDir(), "homes");
}

export const DEFAULT_REGISTRY_URL =
  process.env.MCP_REGISTRY_URL ?? "https://registry.modelcontextprotocol.io/v0/servers";

export const DEFAULT_AWESOME_URL =
  "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md";

export const USER_AGENT =
  "mcp-index/0.1.0 (+https://github.com/KingTunaThe7th/mcp-index)";

/** Local MCP client configs worth importing, in priority order. */
export function localConfigCandidates(): string[] {
  const home = homedir();
  const platform = process.platform;

  if (platform === "darwin") {
    return [
      join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
      join(home, ".cursor/mcp.json"),
      join(home, "Library/Application Support/Code/User/mcp.json"),
    ];
  }

  if (platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      join(appData, "Claude", "claude_desktop_config.json"),
      join(home, ".cursor", "mcp.json"),
      join(appData, "Code", "User", "mcp.json"),
    ];
  }

  return [
    join(home, ".config/Claude/claude_desktop_config.json"),
    join(home, ".cursor/mcp.json"),
    join(home, ".config/Code/User/mcp.json"),
    join(home, ".config/Claude/claude_desktop_config.json"),
  ];
}
