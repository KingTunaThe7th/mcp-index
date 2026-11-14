/**
 * Mount lifecycle: connect, enumerate, pin, expose, tear down.
 *
 * One failed server must not take the gateway down, so connects run
 * independently and failures are recorded on the mount. A mount also has a
 * hard `blocked` state for schema drift: the process stays connected (so you
 * can inspect it) but its tools are not advertised.
 */
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Prompt, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types.js";
import { homesDir, pinsPath } from "../config.js";
import { assertSafeUrl, createGuardedFetch } from "../security/net.js";
import { sanitizeForTerminal } from "../security/sanitize.js";
import {
  DEFAULT_LIMITS,
  buildSandboxedCommand,
  defaultPolicy,
  detectCapabilities,
  selectDriver,
  translateCwd,
} from "../sandbox/index.js";
import type { SandboxPolicy } from "../sandbox/policy.js";
import { checkDrift, digestToolset, loadPins, pinServer, savePins } from "../sandbox/pins.js";
import type { DriftReport, PinStore } from "../sandbox/pins.js";
import type { DriverName } from "../sandbox/detect.js";
import type { MountedServerConfig } from "./config.js";
import { NamespaceRegistry, cleanDescription, validateAlias } from "./router.js";

export type MountStatus = "pending" | "connecting" | "ready" | "blocked" | "error" | "disabled";

export interface MountedServer {
  alias: string;
  config: MountedServerConfig;
  status: MountStatus;
  error: string | null;
  driver: DriverName | null;
  containment: string | null;
  serverInfo: { name: string; version: string } | null;
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: Prompt[];
  drift: DriftReport | null;
  client: Client | null;
}

export interface ManagerOptions {
  driver?: "auto" | DriverName;
  allowUnsandboxed?: boolean;
  pinsPath?: string;
  /** Accept a changed tool schema instead of blocking the mount. */
  autoApproveDrift?: boolean;
  connectTimeoutMs?: number;
  onEvent?: (event: { level: "info" | "warn" | "error"; alias: string; message: string }) => void;
}

const DEFAULT_CONNECT_TIMEOUT = 30_000;

export class GatewayManager {
  readonly registry = new NamespaceRegistry();
  private readonly mounts = new Map<string, MountedServer>();
  private pins: PinStore;
  private readonly options: ManagerOptions;
  private readonly driver: DriverName;

  constructor(servers: Record<string, MountedServerConfig>, options: ManagerOptions = {}) {
    this.options = options;
    this.pins = loadPins(options.pinsPath ?? pinsPath());

    const capabilities = detectCapabilities();
    const selection = selectDriver(options.driver ?? "auto", capabilities);
    this.driver = selection.driver;

    for (const [alias, config] of Object.entries(servers)) {
      this.mounts.set(alias, {
        alias,
        config,
        status: config.enabled === false ? "disabled" : "pending",
        error: null,
        driver: null,
        containment: null,
        serverInfo: null,
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
        drift: null,
        client: null,
      });
    }
  }

  get driverName(): DriverName {
    return this.driver;
  }

  list(): MountedServer[] {
    return [...this.mounts.values()];
  }

  get(alias: string): MountedServer | undefined {
    return this.mounts.get(alias);
  }

  private emit(level: "info" | "warn" | "error", alias: string, message: string): void {
    this.options.onEvent?.({ level, alias, message });
  }

  async startAll(): Promise<void> {
    const active = this.list().filter((mount) => mount.status !== "disabled");
    await Promise.all(active.map((mount) => this.start(mount)));
  }

  async start(mount: MountedServer): Promise<void> {
    const { alias } = mount;
    try {
      validateAlias(alias);
      mount.status = "connecting";

      const client = await this.connect(mount);
      mount.client = client;
      mount.serverInfo = client.getServerVersion() ?? null;

      const tools = (await client.listTools()).tools ?? [];
      const { digest, tools: toolHashes } = digestToolset(
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      );

      const version = mount.serverInfo?.version ?? "unknown";
      const drift = checkDrift(this.pins.servers[alias], { version, digest, tools: toolHashes });
      mount.drift = drift;

      if (drift.status === "new") {
        this.persistPin(alias, { version, digest, tools: toolHashes });
        this.emit("info", alias, "tool schema pinned on first use");
      } else if (drift.status === "drift") {
        if (this.options.autoApproveDrift) {
          this.persistPin(alias, { version, digest, tools: toolHashes });
          this.emit("warn", alias, "tool schema changed; auto-approved by configuration");
        } else {
          mount.status = "blocked";
          mount.error = `tool schema changed since approval (${describeChanges(drift)}). Review it, then run: mcp-index pin approve ${alias}`;
          this.emit("error", alias, mount.error);
          return;
        }
      }

      mount.tools = tools;
      mount.resources = (await this.safeList(() => client.listResources()))?.resources ?? [];
      mount.resourceTemplates =
        (await this.safeList(() => client.listResourceTemplates()))?.resourceTemplates ?? [];
      mount.prompts = (await this.safeList(() => client.listPrompts()))?.prompts ?? [];

      this.registerItems(mount);
      mount.status = "ready";
      this.emit(
        "info",
        alias,
        `ready: ${tools.length} tool(s), ${mount.resources.length} resource(s), ${mount.prompts.length} prompt(s)`,
      );
    } catch (error) {
      mount.status = "error";
      mount.error = error instanceof Error ? error.message : String(error);
      this.emit("error", alias, mount.error);
    }
  }

  private persistPin(
    alias: string,
    next: { version: string; digest: string; tools: Record<string, string> },
  ): void {
    this.pins = pinServer(this.pins, alias, next);
    savePins(this.options.pinsPath ?? pinsPath(), this.pins);
  }

  private policyFor(config: MountedServerConfig): SandboxPolicy {
    return defaultPolicy(this.driver, {
      network: config.network ?? "none",
      persistentHome: config.persistentHome ?? false,
      mounts: config.mounts ?? [],
      runtimePrefixes: config.runtimePrefixes ?? [],
      env: config.env ?? {},
      ...(config.image ? { image: config.image } : {}),
      ...(config.limits ? { limits: { ...DEFAULT_LIMITS, ...config.limits } } : {}),
      allowUnsandboxed: this.options.allowUnsandboxed ?? false,
    });
  }

  private stateDirFor(alias: string): string {
    const dir = `${homesDir()}/${alias}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private async connect(mount: MountedServer): Promise<Client> {
    const { alias, config } = mount;
    const transport = config.transport ?? (config.url && !config.command ? "http" : "stdio");
    const timeout = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;

    const client = new Client(
      { name: "mcp-index-gateway", version: "0.1.0" },
      { capabilities: {} },
    );
    client.onerror = (error) => this.emit("warn", alias, `client error: ${error.message}`);

    if (transport === "stdio") {
      const policy = this.policyFor(config);
      const sandboxCwd = translateCwd(config.cwd, policy.mounts);
      if (config.cwd && sandboxCwd === undefined) {
        this.emit(
          "warn",
          alias,
          `cwd ${config.cwd} is not inside any mount; the server starts in the sandbox home`,
        );
      }

      const built = buildSandboxedCommand(policy, config.command ?? "", config.args ?? [], {
        ...(sandboxCwd ? { cwd: sandboxCwd } : {}),
        ...(config.persistentHome ? { stateDir: this.stateDirFor(alias) } : {}),
      });

      mount.driver = built.driver;
      mount.containment = built.containment;

      const stdio = new StdioClientTransport({
        command: built.command,
        args: built.args,
        env: built.env,
        // Never inherit: a child writing escape sequences to our terminal is
        // exactly the injection this project exists to prevent.
        stderr: "pipe",
      });
      forwardStderr(alias, stdio);

      await client.connect(stdio, { timeout });
      return client;
    }

    const url = await assertSafeUrl(config.url ?? "", {
      allowPrivate: config.allowPrivateNetwork ?? false,
    });

    const http = new StreamableHTTPClientTransport(url, {
      fetch: createGuardedFetch(config.allowPrivateNetwork ?? false),
      ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
    });

    mount.driver = "none";
    mount.containment = "remote endpoint (http); SSRF-guarded, not sandboxed";

    await client.connect(http, { timeout });
    return client;
  }

  private async safeList<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch {
      // Optional capabilities may legitimately be unimplemented.
      return null;
    }
  }

  private registerItems(mount: MountedServer): void {
    this.registry.clearAlias(mount.alias);
    for (const tool of mount.tools) this.registry.registerTool(mount.alias, tool.name);
    for (const prompt of mount.prompts) this.registry.registerPrompt(mount.alias, prompt.name);
    for (const resource of mount.resources) {
      this.registry.registerResource(mount.alias, resource.uri);
    }
  }

  private require(alias: string): Client {
    const mount = this.mounts.get(alias);
    if (!mount) throw new Error(`unknown server "${alias}"`);
    if (!mount.client || mount.status !== "ready") {
      throw new Error(`server "${alias}" is not ready (${mount.status}${mount.error ? `: ${mount.error}` : ""})`);
    }
    return mount.client;
  }

  /** True when this tool must be confirmed by a human before every call. */
  requiresApproval(alias: string, tool: string): boolean {
    return this.mounts.get(alias)?.config.destructiveTools?.includes(tool) ?? false;
  }

  async callTool(
    alias: string,
    name: string,
    args: Record<string, unknown> | undefined,
    options: { timeout?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const client = this.require(alias);
    return client.callTool(
      { name, arguments: args ?? {} },
      undefined,
      { timeout: options.timeout ?? 120_000, ...(options.signal ? { signal: options.signal } : {}) },
    );
  }

  async readResource(
    alias: string,
    uri: string,
    options: { timeout?: number } = {},
  ): Promise<unknown> {
    return this.require(alias).readResource({ uri }, { timeout: options.timeout ?? 60_000 });
  }

  async getPrompt(
    alias: string,
    name: string,
    args: Record<string, string> | undefined,
    options: { timeout?: number } = {},
  ): Promise<unknown> {
    return this.require(alias).getPrompt(
      { name, arguments: args ?? {} },
      { timeout: options.timeout ?? 60_000 },
    );
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      this.list().map(async (mount) => {
        try {
          await mount.client?.close();
        } catch {
          // Shutting down: the child is already gone.
        }
        mount.client = null;
        mount.status = mount.config.enabled === false ? "disabled" : "pending";
      }),
    );
  }
}

function describeChanges(drift: DriftReport): string {
  const parts: string[] = [];
  if (drift.added.length > 0) parts.push(`added ${drift.added.join(", ")}`);
  if (drift.removed.length > 0) parts.push(`removed ${drift.removed.join(", ")}`);
  if (drift.changed.length > 0) parts.push(`changed ${drift.changed.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "digest mismatch";
}

/**
 * Child stderr is untrusted. It is sanitized and prefixed rather than passed
 * through, so a server cannot emit OSC 52 (clipboard) or prompt-rewriting
 * sequences into the host terminal.
 */
function forwardStderr(alias: string, transport: StdioClientTransport): void {
  const stream = transport.stderr;
  if (!stream || typeof stream.on !== "function") return;

  stream.on("data", (chunk: Buffer | string) => {
    const text = sanitizeForTerminal(String(chunk), { maxLength: 2_000 });
    if (text.length > 0) process.stderr.write(`[${alias}] ${text}\n`);
  });
}
