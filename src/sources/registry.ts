/**
 * Official MCP Registry source.
 *
 * The registry schema is still moving, so this parser is deliberately
 * tolerant: it accepts `{ server: {...} }` envelopes as well as bare entries,
 * ignores unknown fields, and skips anything without a usable name rather than
 * failing the whole sync. Malformed upstream data must never abort an update.
 *
 * Header *names* are recorded for remote transports; header values are dropped
 * so a token embedded in registry metadata never reaches the index.
 */
import { DEFAULT_REGISTRY_URL, USER_AGENT } from "../config.js";
import { redactDeep } from "../security/redact.js";
import type { PackageRef, RawServer, RemoteRef } from "../types.js";
import { fetchJson } from "../util/fetch.js";

interface RegistryEnvelope {
  servers?: unknown[];
  metadata?: { nextCursor?: string | null; count?: number };
}

export interface RegistryOptions {
  baseUrl?: string;
  limit?: number;
  maxPages?: number;
  /** `latest` (default) returns one entry per server; `all` returns history. */
  version?: "latest" | "all";
  signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parsePackages(input: unknown): PackageRef[] {
  if (!Array.isArray(input)) return [];
  const out: PackageRef[] = [];

  for (const entry of input) {
    const raw = record(entry);
    if (!raw) continue;

    const identifier = asString(raw.identifier) ?? asString(raw.name);
    if (!identifier) continue;

    const transport = record(raw.transport);
    const version = asString(raw.version);

    out.push({
      registryType: asString(raw.registryType) ?? "unknown",
      identifier,
      ...(version ? { version } : {}),
      ...(transport && asString(transport.type)
        ? { transport: asString(transport.type) as string }
        : {}),
      ...(asString(raw.runtimeHint) ? { runtimeHint: asString(raw.runtimeHint) as string } : {}),
    });
  }

  return out;
}

export function parseRemotes(input: unknown): RemoteRef[] {
  if (!Array.isArray(input)) return [];
  const out: RemoteRef[] = [];

  for (const entry of input) {
    const raw = record(entry);
    if (!raw) continue;

    const url = asString(raw.url);
    if (!url) continue;

    const headers = record(raw.headers);
    out.push({
      type: asString(raw.type) ?? "streamable-http",
      url,
      ...(headers ? { headerNames: Object.keys(headers).sort() } : {}),
    });
  }

  return out;
}

function isOfficial(name: string): boolean {
  return name.startsWith("io.modelcontextprotocol/") || name.startsWith("com.modelcontextprotocol/");
}

export function parseRegistryEntry(entry: unknown): RawServer | null {
  const outer = record(entry);
  if (!outer) return null;

  // Some deployments wrap each entry as { server, _meta }.
  const server = record(outer.server) ?? outer;
  const name = asString(server.name);
  if (!name) return null;

  // Publication metadata lives next to (not inside) the server object.
  const meta = record(outer._meta) ?? record(server._meta);
  const official = meta ? record(meta["io.modelcontextprotocol.registry/official"]) : null;
  const status = official ? asString(official.status) : null;

  // Withdrawals and deprecations should not be indexed as usable servers.
  if (status && status !== "active") return null;

  const repository = record(server.repository);
  const repositoryUrl = repository ? asString(repository.url) : null;
  const updatedAt = official
    ? (asString(official.updatedAt) ?? asString(official.publishedAt))
    : (asString(server.updatedAt) ?? asString(server.publishedAt));

  return {
    source: "registry",
    id: name,
    name,
    title: asString(server.title) ?? asString(server.displayName),
    description: asString(server.description),
    homepage: asString(server.websiteUrl) ?? asString(server.homepage),
    repoUrl: repositoryUrl,
    version: asString(server.version),
    isOfficial: isOfficial(name),
    packages: parsePackages(server.packages),
    remotes: parseRemotes(server.remotes),
    updatedAt: updatedAt ?? null,
    // The envelope is kept for debugging, but it contains the raw `headers`
    // block. Redact before it can reach the database or a log line.
    raw: redactDeep(outer),
  };
}

export function parseRegistryResponse(payload: unknown): {
  servers: RawServer[];
  nextCursor: string | null;
} {
  const envelope = record(payload) as RegistryEnvelope | null;
  const entries = envelope && Array.isArray(envelope.servers) ? envelope.servers : [];

  const servers: RawServer[] = [];
  for (const entry of entries) {
    const parsed = parseRegistryEntry(entry);
    if (parsed) servers.push(parsed);
  }

  const nextCursor = envelope?.metadata ? (envelope.metadata.nextCursor ?? null) : null;
  return { servers, nextCursor: nextCursor || null };
}

export async function fetchRegistryServers(options: RegistryOptions = {}): Promise<RawServer[]> {
  const baseUrl = options.baseUrl ?? DEFAULT_REGISTRY_URL;
  const pageSize = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const maxPages = options.maxPages ?? 50;
  const version = options.version ?? "latest";

  const collected: RawServer[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (page < maxPages) {
    const url = new URL(baseUrl);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("version", version);
    if (cursor) url.searchParams.set("cursor", cursor);

    const payload = await fetchJson<unknown>(url.toString(), {
      headers: { "user-agent": USER_AGENT },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const { servers, nextCursor } = parseRegistryResponse(payload);
    collected.push(...servers);

    page += 1;
    if (!nextCursor || servers.length === 0) break;
    cursor = nextCursor;
  }

  return collected;
}
