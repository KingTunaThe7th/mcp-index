/**
 * Public library surface.
 *
 * Everything the CLI uses is importable, so the index and the gateway can be
 * embedded in another service without shelling out.
 */
export * from "./types.js";
export {
  buildFtsQuery,
  getServer,
  getStats,
  listCategories,
  migrate,
  openDb,
  searchServers,
  upsertServerRecords,
} from "./db/index.js";
export type { DatabaseSync, IndexStats, StatementSync, UpsertResult } from "./db/index.js";
export { runSync } from "./ingest/pipeline.js";
export type { SyncOptions } from "./ingest/pipeline.js";
export { normalizeServers, canonicalRepo, deriveInstall } from "./ingest/normalize.js";
export { fetchRegistryServers, parseRegistryResponse } from "./sources/registry.js";
export { fetchAwesomeServers, parseAwesomeReadme } from "./sources/awesome.js";
export { readLocalConfigs, parseLocalConfig } from "./sources/local.js";
export * from "./security/sanitize.js";
export * from "./security/redact.js";
export * from "./security/net.js";
export * from "./sandbox/index.js";
export { GatewayManager } from "./gateway/manager.js";
export { createGatewayServer } from "./gateway/server.js";
export { ConfigError, loadGatewayConfig, parseGatewayConfig } from "./gateway/config.js";
export type { GatewaySettings, MountedServerConfig } from "./gateway/config.js";
export { runHttpGateway, runStdioGateway } from "./gateway/index.js";
export { startHttpServer } from "./http/server.js";
export type { CatalogApi, HttpServerOptions, RunningHttpServer } from "./http/server.js";
export { buildClientConfig, entryAlias, formatLaunch } from "./catalog/snippet.js";
export { indexPath, pinsPath, homeDir } from "./config.js";
