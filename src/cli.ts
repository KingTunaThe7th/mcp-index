#!/usr/bin/env node
/**
 * `mcp-index` command line.
 *
 * Two halves in one binary:
 *   - catalog commands (`sync`, `search`, `show`) work on a local SQLite file
 *   - gateway commands (`gateway`, `serve`) mount third-party servers behind
 *     one endpoint, always through a sandbox driver
 *
 * Exit codes: 0 success, 1 error, 2 usage/config problem.
 */
import { existsSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { indexPath, pinsPath } from "./config.js";
import {
  getServer,
  getStats,
  listCategories,
  openDb,
  searchServers,
} from "./db/index.js";
import { runSync } from "./ingest/pipeline.js";
import { buildClientConfig, clientFromString, formatLaunch } from "./catalog/snippet.js";
import type { ClientKind } from "./catalog/snippet.js";
import { ConfigError, loadGatewayConfig, runHttpGateway, runStdioGateway } from "./gateway/index.js";
import { GatewayManager } from "./gateway/manager.js";
import { tokenPath } from "./http/auth.js";
import { doctor as inspectSandbox } from "./sandbox/index.js";
import { describeDrift, loadPins, savePins } from "./sandbox/pins.js";
import type { SourceName, TransportKind } from "./types.js";
import { log, setJsonMode, setLogLevel } from "./util/log.js";
import type { LogLevel } from "./util/log.js";

const VERSION = "0.1.0";

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function isJson(): boolean {
  return log.isJson();
}

function platformHint(platform: NodeJS.Platform): string {
  if (platform === "linux") return "install bubblewrap: sudo apt install bubblewrap";
  if (platform === "darwin") return "use --driver docker with a pinned image, or --allow-unsandboxed";
  return "use --driver docker with a pinned image, or --allow-unsandboxed";
}

function parseSources(values: string[] | undefined): SourceName[] | undefined {
  if (!values || values.length === 0) return undefined;
  const allowed: SourceName[] = ["registry", "awesome", "local"];
  const parsed: SourceName[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase() as SourceName;
    if (!allowed.includes(normalized)) {
      throw new Error(`unknown source "${value}" (expected: ${allowed.join(", ")})`);
    }
    parsed.push(normalized);
  }
  return parsed;
}

function openIndex(readOnly: boolean) {
  const path = indexPath();
  if (!existsSync(path)) {
    throw new Error(`no index at ${path}; run \`mcp-index sync\` first`);
  }
  return openDb(path, { readOnly });
}

function table(rows: string[][], headers: string[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}


export function buildProgram(): Command {
  const program = new Command();

  program
    .name("mcp-index")
    .description("Index the MCP server ecosystem and mount servers behind one sandboxed endpoint.")
    .version(VERSION)
    .option("--json", "machine-readable output", false)
    .option("--db <path>", "index database path")
    .option("--verbose", "debug logging", false)
    .option("--quiet", "errors only", false)
    .hook("preAction", (thisCommand) => {
      const options = thisCommand.opts();
      setJsonMode(Boolean(options.json));
      const level: LogLevel = options.quiet ? "error" : options.verbose ? "debug" : "info";
      setLogLevel(level);
      if (typeof options.db === "string" && options.db.length > 0) {
        process.env.MCP_INDEX_DB = options.db;
      }
    });

  program
    .command("sync")
    .description("refresh the index from the registry, the awesome list and local configs")
    .option("-s, --source <name...>", "limit to registry|awesome|local (repeatable)")
    .option("--registry-url <url>", "override the registry endpoint")
    .option("--awesome-url <url>", "override the awesome-list markdown URL")
    .option("--no-local", "do not read local MCP client configs")
    .action(async (options: {
      source?: string[];
      registryUrl?: string;
      awesomeUrl?: string;
      local?: boolean;
    }) => {
      const db = openDb(indexPath());
      const sources = parseSources(options.source);
      const report = await runSync(db, {
        ...(sources ? { sources } : {}),
        ...(options.registryUrl ? { registryUrl: options.registryUrl } : {}),
        ...(options.awesomeUrl ? { awesomeUrl: options.awesomeUrl } : {}),
        ...(options.local === false ? { localConfigs: [] } : {}),
      });
      db.close();

      if (isJson()) {
        emit(report);
        return;
      }

      for (const [name, source] of Object.entries(report.sources)) {
        if (source.error) log.warn(`${name}: ${source.error}`);
        else log.info(`${name}: ${source.fetched} entries`);
      }
      log.info(
        `${report.normalized} unique servers (${report.inserted} new, ${report.updated} updated) in ${report.durationMs}ms`,
      );
    });

  program
    .command("search [query...]")
    .description("full-text search over the catalog")
    .option("-c, --category <tag>", "filter by category/tag")
    .option("-t, --transport <kind>", "stdio|remote|both|unknown")
    .option("-l, --language <name>", "filter by language")
    .option("--official", "official servers only", false)
    .option("--any", "match any term instead of all", false)
    .option("--limit <n>", "maximum results", "20")
    .option("--offset <n>", "skip N results", "0")
    .action((query: string[], options: {
      category?: string;
      transport?: string;
      language?: string;
      official?: boolean;
      any?: boolean;
      limit: string;
      offset: string;
    }) => {
      const db = openIndex(true);
      const transport = options.transport as TransportKind | undefined;
      const hits = searchServers(db, {
        query: query.join(" ").trim() || undefined,
        ...(options.category ? { category: options.category } : {}),
        ...(transport ? { transport } : {}),
        ...(options.language ? { language: options.language } : {}),
        officialOnly: Boolean(options.official),
        matchAll: Boolean(options.any),
        limit: Number.parseInt(options.limit, 10) || 20,
        offset: Number.parseInt(options.offset, 10) || 0,
      });
      db.close();

      if (isJson()) {
        emit({ count: hits.length, hits });
        return;
      }
      if (hits.length === 0) {
        log.info("no matches");
        return;
      }

      for (const hit of hits) {
        const flags = [hit.transportKind, hit.isOfficial ? "official" : "", hit.language ?? ""]
          .filter(Boolean)
          .join(" ");
        log.out(`${hit.name}  [${flags}]`);
        log.out(`  ${hit.id}`);
        if (hit.description) log.out(`  ${hit.description.slice(0, 160)}`);
        log.out(`  ${formatLaunch(hit)}`);
        log.out("");
      }
    });

  program
    .command("show <id>")
    .description("print one catalog entry, including its install snippets")
    .action((id: string) => {
      const db = openIndex(true);
      const record = getServer(db, id);
      db.close();

      if (!record) {
        throw new Error(`no server matching "${id}" in the index`);
      }
      if (isJson()) {
        emit(record);
        return;
      }

      log.out(`${record.name}${record.isOfficial ? " [official]" : ""}`);
      log.out(`id:          ${record.id}`);
      log.out(`transport:   ${record.transportKind}`);
      if (record.version) log.out(`version:     ${record.version}`);
      if (record.language) log.out(`language:    ${record.language}`);
      if (record.repoUrl) log.out(`repo:        ${record.repoUrl}`);
      if (record.homepage) log.out(`homepage:    ${record.homepage}`);
      if (record.categories.length) log.out(`categories:  ${record.categories.join(", ")}`);
      log.out(`sources:     ${record.sources.join(", ")}`);
      log.out(`updated:     ${record.updatedAt ?? "unknown"}`);
      if (record.description) log.out(`\n${record.description}`);
      log.out(`\nlaunch: ${formatLaunch(record)}`);
    });

  program
    .command("categories")
    .description("list the category/tag distribution")
    .option("--limit <n>", "maximum tags", "40")
    .action((options: { limit: string }) => {
      const db = openIndex(true);
      const rows = listCategories(db, Number.parseInt(options.limit, 10) || 40);
      db.close();

      if (isJson()) {
        emit(rows);
        return;
      }
      log.out(table(rows.map((row) => [row.tag, String(row.count)]), ["tag", "count"]));
    });

  program
    .command("stats")
    .description("summarize the index")
    .action(() => {
      const db = openIndex(true);
      const stats = getStats(db);
      db.close();

      if (isJson()) {
        emit(stats);
        return;
      }
      log.out(`total:     ${stats.total}`);
      log.out(`official:  ${stats.official}`);
      log.out(`last sync: ${stats.lastSync ?? "never"}`);
      log.out(`sources:   ${JSON.stringify(stats.bySource)}`);
      log.out(`transports:${JSON.stringify(stats.byTransport)}`);
    });

  program
    .command("snippet <id>")
    .description("emit a client config fragment for one server")
    .option("--client <name>", "claude|cursor|vscode|generic", "claude")
    .action((id: string, options: { client: string }) => {
      const db = openIndex(true);
      const record = getServer(db, id);
      db.close();

      if (!record) throw new Error(`no server matching "${id}" in the index`);
      const client: ClientKind = clientFromString(options.client);
      emit(buildClientConfig(record, client));
    });

  program
    .command("doctor")
    .description("report sandbox capabilities and index state")
    .action(() => {
      const report = inspectSandbox();
      const index = indexPath();
      const payload = {
        ...report,
        index: { path: index, exists: existsSync(index) },
        pins: pinsPath(),
        config: existsSync("mcp-index.json") ? "mcp-index.json" : null,
        platformHint: platformHint(report.capabilities.platform),
      };

      if (isJson()) {
        emit(payload);
        return;
      }

      log.out(`platform:     ${report.capabilities.platform}`);
      log.out(`bubblewrap:   ${report.capabilities.bwrap ? "usable" : "NOT usable"}${report.capabilities.bwrapVersion ? ` (${report.capabilities.bwrapVersion})` : ""}`);
      log.out(`docker:       ${report.capabilities.docker ? "present" : "absent"}`);
      log.out(`podman:       ${report.capabilities.podman ? "present" : "absent"}`);
      log.out(`unshare:      ${report.capabilities.unshare ? "present (network only)" : "absent"}`);
      log.out(`prlimit:      ${report.prlimit ? "present" : "absent"}`);
      log.out(`userns:       ${report.capabilities.userNamespaces ? "enabled" : "restricted"}`);
      log.out(`recommended:  ${report.recommended}`);
      log.out(`runtimes:     ${report.runtimePrefixes.join(", ") || "none discovered"}`);
      log.out(`index:        ${index}${existsSync(index) ? "" : " (missing; run sync)"}`);
      for (const warning of report.warnings) log.warn(warning);
      if (report.recommended === "none") log.warn(platformHint(report.capabilities.platform));
    });

  program
    .command("init")
    .description("write a starter mcp-index.json in the current directory")
    .option("--force", "overwrite an existing file", false)
    .action((options: { force?: boolean }) => {
      const path = "mcp-index.json";
      if (existsSync(path) && !options.force) {
        throw new Error(`${path} already exists (use --force to overwrite)`);
      }
      const template = {
        gateway: { driver: "auto", allowUnsandboxed: false, host: "127.0.0.1", port: 7777 },
        servers: {
          files: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"],
            mounts: [{ source: "/path/to/project", target: "/work", mode: "ro" }],
            network: "none",
            destructiveTools: ["write_file", "edit_file", "move_file"],
          },
        },
      };
      writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
      log.info(`wrote ${path} (edit the paths, then run \`mcp-index gateway\`)`);
    });

  const pin = program.command("pin").description("manage trust-on-first-use tool pins");

  pin
    .command("list")
    .description("show approved tool digests")
    .action(() => {
      const store = loadPins(pinsPath());
      const entries = Object.entries(store.servers);
      if (isJson()) {
        emit(store);
        return;
      }
      if (entries.length === 0) {
        log.info("no pins recorded yet (a pin is created the first time a server connects)");
        return;
      }
      const rows = entries.map(([alias, record]) => [
        alias,
        record.version,
        record.digest.slice(0, 12),
        String(Object.keys(record.tools).length),
        record.approvedAt,
      ]);
      log.out(table(rows, ["alias", "version", "digest", "tools", "approved"]));
    });

  pin
    .command("approve <alias>")
    .description("connect once and trust the current tool schema")
    .option("--config <path>", "gateway config path")
    .option("--driver <name>", "auto|bwrap|docker|podman|unshare|none")
    .option("--allow-unsandboxed", "run without isolation (dangerous)", false)
    .action(async (alias: string, options: {
      config?: string;
      driver?: string;
      allowUnsandboxed?: boolean;
    }) => {
      const config = loadGatewayConfig(options.config);
      const entry = config.servers[alias];
      if (!entry) throw new Error(`no server "${alias}" in the gateway config`);

      const manager = new GatewayManager(
        { [alias]: entry },
        {
          ...(options.driver ? { driver: options.driver as never } : {}),
          allowUnsandboxed: Boolean(options.allowUnsandboxed),
          autoApproveDrift: true,
          onEvent: (event) => log.info(`[${event.alias}] ${event.message}`),
        },
      );

      const mount = manager.get(alias);
      if (!mount) throw new Error(`failed to prepare "${alias}"`);
      await manager.start(mount);
      await manager.stopAll();

      if (mount.status !== "ready") {
        throw new Error(`could not approve "${alias}": ${mount.error ?? mount.status}`);
      }
      const store = loadPins(pinsPath());
      const record = store.servers[alias];
      log.info(
        record
          ? `approved ${alias}: ${Object.keys(record.tools).length} tool(s), digest ${record.digest.slice(0, 12)}`
          : `approved ${alias}`,
      );
    });

  pin
    .command("remove <alias>")
    .description("forget an approved tool schema")
    .action((alias: string) => {
      const store = loadPins(pinsPath());
      if (!(alias in store.servers)) throw new Error(`no pin for "${alias}"`);
      delete store.servers[alias];
      savePins(pinsPath(), store);
      log.info(`removed pin for ${alias}`);
    });

  program
    .command("gateway")
    .description("run one aggregated MCP server over stdio")
    .option("--config <path>", "gateway config path")
    .option("--driver <name>", "auto|bwrap|docker|podman|unshare|none")
    .option("--allow-unsandboxed", "run without isolation (dangerous)", false)
    .action(async (options: { config?: string; driver?: string; allowUnsandboxed?: boolean }) => {
      await runStdioGateway({
        ...(options.config ? { configPath: options.config } : {}),
        ...(options.driver ? { driver: options.driver as never } : {}),
        allowUnsandboxed: Boolean(options.allowUnsandboxed),
      });
    });

  program
    .command("serve")
    .description("run the dashboard, JSON API and Streamable HTTP MCP endpoint")
    .option("--config <path>", "gateway config path")
    .option("--driver <name>", "auto|bwrap|docker|podman|unshare|none")
    .option("--allow-unsandboxed", "run without isolation (dangerous)", false)
    .option("--host <addr>", "bind address", "127.0.0.1")
    .option("--port <n>", "port", "7777")
    .option("--print-token", "print the bearer token to stdout", false)
    .action(async (options: {
      config?: string;
      driver?: string;
      allowUnsandboxed?: boolean;
      host: string;
      port: string;
      printToken?: boolean;
    }) => {
      const db = openIndex(true);
      const catalog = {
        search: (searchOptions: Parameters<typeof searchServers>[1]) =>
          searchServers(db, searchOptions),
        stats: () => getStats(db),
      };

      const running = await runHttpGateway({
        ...(options.config ? { configPath: options.config } : {}),
        ...(options.driver ? { driver: options.driver as never } : {}),
        allowUnsandboxed: Boolean(options.allowUnsandboxed),
        host: options.host,
        port: Number.parseInt(options.port, 10),
        catalog,
      });

      log.out(`dashboard:  ${running.url}`);
      log.out(`mcp:        ${running.url}/mcp`);
      log.out(`token file: ${tokenPath()}`);
      if (options.printToken) log.out(`token:      ${running.token}`);
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  await program.parseAsync(argv);
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /cli\.(?:ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main()
    // Do not call process.exit(0) on success: `gateway` and `serve` are
    // long-running and rely on the event loop staying alive. Short commands
    // still exit naturally once there is nothing left to do.
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`error: ${message}\n`);
      const usageProblem =
        error instanceof ConfigError ||
        /^(unknown|no |invalid|config)/i.test(message) ||
        message.includes("requires");
      process.exit(usageProblem ? 2 : 1);
    });
}
