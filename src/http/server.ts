/**
 * Local HTTP surface: dashboard, JSON API, and a Streamable HTTP MCP endpoint.
 *
 * Security posture:
 *   - binds to 127.0.0.1 by default
 *   - rejects unknown `Host` headers (DNS rebinding)
 *   - rejects cross-site `Origin`s, and never emits CORS headers
 *   - requires a bearer token for every API and MCP request, compared in
 *     constant time
 *   - the dashboard is served with a strict CSP and a per-request nonce
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { DatabaseSync } from "node:sqlite";
import type { IndexStats } from "../db/index.js";
import type { SearchHit, SearchOptions } from "../types.js";
import { checkHost, checkOrigin, extractBearer, tokenMatches } from "./auth.js";
import { DASHBOARD_HTML } from "./ui.js";
import { createGatewayServer } from "../gateway/server.js";
import type { GatewayManager } from "../gateway/manager.js";

export interface CatalogApi {
  search(options: SearchOptions): SearchHit[];
  stats(): IndexStats;
}

export interface HttpServerOptions {
  host?: string;
  port?: number;
  token: string;
  manager: GatewayManager;
  catalog: CatalogApi;
  /** Extra path to serve the MCP endpoint on. */
  mcpPath?: string;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function parseSearchQuery(url: URL): SearchOptions {
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const transport = url.searchParams.get("transport");

  return {
    query: url.searchParams.get("q") ?? undefined,
    category: url.searchParams.get("category") ?? undefined,
    language: url.searchParams.get("language") ?? undefined,
    officialOnly: url.searchParams.get("official") === "1",
    transport:
      transport === "stdio" || transport === "remote" || transport === "both" || transport === "unknown"
        ? transport
        : undefined,
    limit: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20,
    offset: Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0,
  };
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 7777;
  const mcpPath = options.mcpPath ?? "/mcp";

  let boundPort = requestedPort;

  const authorized = (req: IncomingMessage): boolean => {
    const token = extractBearer(req.headers.authorization);
    return token !== null && tokenMatches(token, options.token);
  };

  const publicHit = (hit: SearchHit): Omit<SearchHit, "raw"> => {
    const { raw, ...rest } = hit;
    void raw;
    return rest;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const policy = { host, port: boundPort };

      // DNS-rebinding guard: the browser cannot forge Host.
      if (!checkHost(req.headers.host, policy)) {
        sendText(res, 421, "misdirected request: unrecognised Host header");
        return;
      }
      if (!checkOrigin(req.headers.origin, policy)) {
        sendText(res, 403, "cross-origin request refused");
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${boundPort}`}`);
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      // Preflight is answered without CORS headers on purpose: same-origin only.
      if (method === "OPTIONS") {
        res.writeHead(204, {
          allow: "GET, HEAD, POST, DELETE, OPTIONS",
          "cache-control": "no-store",
        });
        res.end();
        return;
      }

      if (pathname === "/" || pathname === "/index.html") {
        if (method !== "GET" && method !== "HEAD") {
          sendText(res, 405, "method not allowed");
          return;
        }
        const nonce = randomBytes(16).toString("base64");
        const html = DASHBOARD_HTML.replace("<script>", `<script nonce="${nonce}">`);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
          "cache-control": "no-store",
          "content-security-policy": [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            "style-src 'unsafe-inline'",
            "connect-src 'self'",
            "img-src data:",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join("; "),
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
        });
        res.end(html);
        return;
      }

      if (pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }

      if (pathname === mcpPath) {
        if (!authorized(req)) {
          res.setHeader("www-authenticate", 'Bearer realm="mcp-index"');
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        let body: unknown;
        if (method === "POST") {
          try {
            const raw = await readBody(req);
            body = JSON.parse(raw);
          } catch (error) {
            const tooLarge = error instanceof BodyTooLarge;
            sendJson(res, tooLarge ? 413 : 400, {
              jsonrpc: "2.0",
              error: { code: -32700, message: tooLarge ? "body too large" : "parse error" },
              id: null,
            });
            return;
          }
        }

        const mcpServer = createGatewayServer(options.manager);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on("close", () => {
          void transport.close();
          void mcpServer.close();
        });

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (!pathname.startsWith("/api/")) {
        sendText(res, 404, "not found");
        return;
      }

      if (!authorized(req)) {
        res.setHeader("www-authenticate", 'Bearer realm="mcp-index"');
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      switch (pathname) {
        case "/api/health": {
          sendJson(res, 200, {
            ok: true,
            version: "0.1.0",
            driver: options.manager.driverName,
            mounts: options.manager.list().length,
          });
          return;
        }
        case "/api/stats": {
          sendJson(res, 200, options.catalog.stats());
          return;
        }
        case "/api/search": {
          const searchOptions = parseSearchQuery(url);
          const hits = options.catalog.search(searchOptions);
          sendJson(res, 200, {
            count: hits.length,
            query: searchOptions.query ?? null,
            hits: hits.map(publicHit),
          });
          return;
        }
        case "/api/servers": {
          sendJson(res, 200, {
            driver: options.manager.driverName,
            servers: options.manager.list().map((mount) => ({
              alias: mount.alias,
              status: mount.status,
              driver: mount.driver,
              containment: mount.containment,
              error: mount.error,
              toolCount: mount.tools.length,
              resourceCount: mount.resources.length,
              promptCount: mount.prompts.length,
              serverInfo: mount.serverInfo,
              drift: mount.drift,
              tools: mount.tools.map((tool) => tool.name),
            })),
          });
          return;
        }
        default:
          sendJson(res, 404, { error: "not found" });
      }
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : "internal error" });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      const address = server.address();
      if (address && typeof address === "object") boundPort = address.port;
      resolve();
    });
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

