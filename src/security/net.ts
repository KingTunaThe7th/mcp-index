/**
 * SSRF guard for remote MCP transports.
 *
 * A gateway that blindly connects to a `url` from registry metadata is an SSRF
 * proxy: it will happily fetch cloud metadata (`169.254.169.254`), internal
 * admin panels, or `localhost` services, and hand the response back to a model.
 *
 * Every remote endpoint is resolved and checked before connecting. Loopback,
 * link-local, private, CGNAT, multicast and reserved ranges are refused unless
 * the operator opts in per-server with `allowPrivateNetwork`.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`unsafe URL rejected (${reason}): ${url}`);
    this.name = "UnsafeUrlError";
    this.url = url;
  }
}

const ALWAYS_BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "metadata.azure.internal",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed => treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function expandIPv6(input: string): number[] | null {
  let ip = input.trim();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);

  if (ip.includes(".")) {
    const idx = ip.lastIndexOf(":");
    if (idx === -1) return null;
    const v4 = ip
      .slice(idx + 1)
      .split(".")
      .map((part) => Number(part));
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = (((v4[0] as number) << 8) | (v4[1] as number)).toString(16);
    const lo = (((v4[2] as number) << 8) | (v4[3] as number)).toString(16);
    ip = `${ip.slice(0, idx + 1)}${hi}:${lo}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0] ?? "");
  if (head === null) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tail = parseGroups(halves[1] ?? "");
  if (tail === null) return null;

  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;

  const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  return groups.length === 8 ? groups : null;
}

export function isPrivateIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (groups === null) return true;

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];

  const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::  and ::1
  if (allZeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
  if (allZeroPrefix && (g5 === 0xffff || g5 === 0)) {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isPrivateIPv4(v4);
  }

  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

export interface UrlGuardOptions {
  /** Allow loopback/private/`.local` targets. Opt-in, per server. */
  allowPrivate?: boolean;
  allowedSchemes?: string[];
}

export async function assertSafeUrl(raw: string, options: UrlGuardOptions = {}): Promise<URL> {
  const allowPrivate = options.allowPrivate ?? false;
  const allowedSchemes = new Set(
    (options.allowedSchemes ?? ["http", "https"]).map((scheme) =>
      scheme.endsWith(":") ? scheme.toLowerCase() : `${scheme.toLowerCase()}:`,
    ),
  );

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(raw, "not a valid absolute URL");
  }

  if (!allowedSchemes.has(url.protocol)) {
    throw new UnsafeUrlError(raw, `scheme "${url.protocol}" is not allowed`);
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError(raw, "URL must not embed credentials");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (!allowPrivate) {
    if (ALWAYS_BLOCKED_HOSTS.has(host)) {
      throw new UnsafeUrlError(raw, "loopback/metadata hostname");
    }
    if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      throw new UnsafeUrlError(raw, "local-only hostname");
    }
  }

  if (isIP(host) !== 0) {
    if (!allowPrivate && isPrivateAddress(host)) {
      throw new UnsafeUrlError(raw, "private/loopback address");
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError(raw, "DNS resolution failed");
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(raw, "hostname did not resolve");
  }

  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        throw new UnsafeUrlError(raw, `hostname resolves to private address ${address}`);
      }
    }
  }

  return url;
}
