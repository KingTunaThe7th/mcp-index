/**
 * Bearer-token auth for the local HTTP surface.
 *
 * The gateway binds to loopback, but "loopback" is not a security boundary:
 * any page in a browser can POST to 127.0.0.1, and any local process can too.
 * A token is generated once, stored 0600, and compared in constant time.
 */
import { createHash, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../config.js";

const MIN_TOKEN_LENGTH = 24;

export function tokenPath(): string {
  return join(homeDir(), "token");
}

export function loadOrCreateToken(explicit?: string): string {
  if (explicit && explicit.length >= 16) return explicit;

  const fromEnv = process.env.MCP_INDEX_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  const path = tokenPath();
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, "utf8").trim();
      if (existing.length >= MIN_TOKEN_LENGTH) return existing;
    } catch {
      // Fall through and mint a new one.
    }
  }

  const token = randomBytes(32).toString("base64url");
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/** Constant-time comparison over fixed-length digests. */
export function tokenMatches(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return nodeTimingSafeEqual(a, b);
}

export function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() ?? null;
}

export interface OriginPolicy {
  host: string;
  port: number;
}

/** Only the exact loopback authorities we advertise are acceptable. */
export function allowedHosts(policy: OriginPolicy): Set<string> {
  const { host, port } = policy;
  const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (host !== "127.0.0.1" && host !== "localhost") hosts.add(`${host}:${port}`);
  return hosts;
}

export function allowedOrigins(policy: OriginPolicy): Set<string> {
  const { host, port } = policy;
  const origins = new Set<string>([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  if (host !== "127.0.0.1" && host !== "localhost") origins.add(`http://${host}:${port}`);
  return origins;
}

/**
 * A browser cannot set `Host`, so rejecting unknown Host headers blocks DNS
 * rebinding: an attacker's domain that resolves to 127.0.0.1 still sends its
 * own hostname.
 */
export function checkHost(
  header: string | string[] | undefined,
  policy: OriginPolicy,
): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  return allowedHosts(policy).has(value.toLowerCase());
}

export function checkOrigin(
  header: string | string[] | undefined,
  policy: OriginPolicy,
): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  // Same-origin fetches from a browser always send Origin for POST; non-browser
  // clients (curl, the MCP SDK) usually omit it.
  if (!value) return true;
  return allowedOrigins(policy).has(value.toLowerCase());
}
