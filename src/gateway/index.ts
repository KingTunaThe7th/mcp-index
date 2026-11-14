/**
 * Gateway entry points: stdio (default) and HTTP.
 *
 * In stdio mode stdout carries the MCP protocol, so all logging is rerouted to
 * stderr before anything else happens. Startup fails loudly when no server is
 * configured, when the sandbox driver is unusable, or when a mount is blocked
 * by schema drift -- silently exposing a partial surface would be worse.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { DriverName } from "../sandbox/detect.js";
import { log, setStdioSafe } from "../util/log.js";
import { loadGatewayConfig } from "./config.js";
import type { GatewaySettings, MountedServerConfig } from "./config.js";
import { GatewayManager } from "./manager.js";
import { createGatewayServer } from "./server.js";
import type { CatalogApi } from "../http/server.js";
import { startHttpServer } from "../http/server.js";
import { loadOrCreateToken } from "../http/auth.js";

export interface GatewayRunOptions {
  configPath?: string;
  driver?: "auto" | DriverName;
  allowUnsandboxed?: boolean;
  host?: string;
  port?: number;
  token?: string;
  catalog?: CatalogApi;
  servers?: Record<string, MountedServerConfig>;
  settings?: GatewaySettings;
}

export interface RunningGateway {
  manager: GatewayManager;
  close(): Promise<void>;
}

interface ResolvedSettings {
  driver: "auto" | DriverName;
  allowUnsandboxed: boolean;
  host: string;
  port: number;
  token: string;
}

function resolveSettings(
  options: GatewayRunOptions,
  fromFile: GatewaySettings,
): ResolvedSettings {
  return {
    driver: options.driver ?? fromFile.driver ?? "auto",
    allowUnsandboxed: options.allowUnsandboxed ?? fromFile.allowUnsandboxed ?? false,
    host: options.host ?? fromFile.host ?? "127.0.0.1",
    port: options.port ?? fromFile.port ?? 7777,
    token: loadOrCreateToken(options.token ?? fromFile.token),
  };
}

function buildManager(options: GatewayRunOptions): GatewayManager {
  const config = options.servers
    ? { path: null, settings: options.settings ?? {}, servers: options.servers }
    : loadGatewayConfig(options.configPath);

  const entries = Object.entries(config.servers);
  if (entries.length === 0) {
    throw new Error(
      config.path
        ? `no servers configured in ${config.path}`
        : 'no servers configured: create mcp-index.json with a "servers" object, or pass --config',
    );
  }

  const settings = resolveSettings(options, config.settings);

  if (settings.driver === "none" && !settings.allowUnsandboxed) {
    // Fail before spawning anything: this is the whole point of the project.
    throw new Error(
      "no sandbox mechanism is available (install bubblewrap), or pass --allow-unsandboxed to accept full host access",
    );
  }

  return new GatewayManager(config.servers, {
    driver: settings.driver,
    allowUnsandboxed: settings.allowUnsandboxed,
    onEvent: (event) => {
      if (event.level === "error") log.error(`[${event.alias}] ${event.message}`);
      else if (event.level === "warn") log.warn(`[${event.alias}] ${event.message}`);
      else log.info(`[${event.alias}] ${event.message}`);
    },
  });
}

/** stdio gateway: one client, protocol on stdout. */
export async function runStdioGateway(options: GatewayRunOptions = {}): Promise<RunningGateway> {
  setStdioSafe(true);

  const manager = buildManager(options);
  log.info(`sandbox driver: ${manager.driverName}`);
  await manager.startAll();

  const blocked = manager.list().filter((mount) => mount.status === "blocked");
  const failed = manager.list().filter((mount) => mount.status === "error");
  if (failed.length > 0) {
    log.warn(`${failed.length} server(s) failed to start: ${failed.map((m) => m.alias).join(", ")}`);
  }

  const server = createGatewayServer(manager);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    await manager.stopAll();
    await server.close().catch(() => undefined);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
  server.onclose = () => {
    void shutdown().finally(() => process.exit(0));
  };

  log.info(
    blocked.length > 0 ? `gateway ready with ${blocked.length} blocked mount(s)` : "gateway ready",
  );

  return { manager, close: shutdown };
}

/** HTTP gateway: dashboard + JSON API + Streamable HTTP MCP. */
export async function runHttpGateway(options: GatewayRunOptions = {}): Promise<{
  manager: GatewayManager;
  url: string;
  token: string;
  close(): Promise<void>;
}> {
  const config = options.servers
    ? { settings: options.settings ?? {} }
    : loadGatewayConfig(options.configPath);

  const manager = buildManager(options);
  log.info(`sandbox driver: ${manager.driverName}`);
  await manager.startAll();

  const settings = resolveSettings(options, config.settings);

  if (!options.catalog) {
    throw new Error("HTTP gateway requires a catalog; run `mcp-index sync` first");
  }

  const running = await startHttpServer({
    host: settings.host,
    port: settings.port,
    token: settings.token,
    manager,
    catalog: options.catalog,
  });

  log.info(`listening on ${running.url}`);
  if (settings.host !== "127.0.0.1" && settings.host !== "localhost") {
    log.warn(
      `bound to ${settings.host}, not loopback: the bearer token is now the only access control`,
    );
  }

  const close = async (): Promise<void> => {
    await running.close();
    await manager.stopAll();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().finally(() => process.exit(0));
    });
  }

  return { manager, url: running.url, token: settings.token, close };
}

export { GatewayManager } from "./manager.js";
export { createGatewayServer } from "./server.js";
export { ConfigError, loadGatewayConfig, parseGatewayConfig } from "./config.js";
export type { GatewaySettings, MountedServerConfig } from "./config.js";
