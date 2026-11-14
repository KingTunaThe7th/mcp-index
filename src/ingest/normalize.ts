/**
 * Normalization: many observations -> one row per server.
 *
 * The same server routinely appears in the registry, in the awesome list, and
 * in your local client config. Matching is done on the canonical repo URL,
 * because the registry's reverse-DNS name and a markdown link share nothing
 * else.
 *
 * Field precedence is registry > local > awesome: the registry has machine
 * readable packages/transports, local configs prove something actually runs,
 * and the awesome list is best for human prose and categories.
 */
import { redactDeep, redactString } from "../security/redact.js";
import { sanitize } from "../security/sanitize.js";
import type {
  InstallSnippet,
  PackageRef,
  RawServer,
  RemoteRef,
  ServerRecord,
  SourceName,
  TransportKind,
} from "../types.js";

const SOURCE_PRIORITY: Record<SourceName, number> = { registry: 0, local: 1, awesome: 2 };

export function canonicalRepo(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);

    if (host === "github.com" || host === "gitlab.com" || host === "codeberg.org") {
      if (segments.length < 2) return null;
      const owner = (segments[0] as string).toLowerCase();
      const repo = (segments[1] as string).replace(/\.git$/i, "").toLowerCase();
      return `${host}/${owner}/${repo}`;
    }

    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    return path.length > 0 ? `${host}${path}` : host;
  } catch {
    return null;
  }
}

export function slugify(input: string): string {
  return sanitize(input, { maxLength: 80 })
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/-{2,}/g, "-");
}

function text(value: string | null | undefined, maxLength = 600): string | null {
  if (typeof value !== "string") return null;
  const cleaned = sanitize(redactString(value), { maxLength });
  return cleaned.length > 0 ? cleaned : null;
}

function firstText(values: Array<string | null | undefined>, maxLength = 600): string | null {
  for (const value of values) {
    const cleaned = text(value, maxLength);
    if (cleaned) return cleaned;
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const cleaned = sanitize(value, { maxLength: 64 });
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function dedupePackages(packages: PackageRef[]): PackageRef[] {
  const seen = new Set<string>();
  const out: PackageRef[] = [];
  for (const pkg of packages) {
    const key = `${pkg.registryType}:${pkg.identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pkg);
  }
  return out;
}

function dedupeRemotes(remotes: RemoteRef[]): RemoteRef[] {
  const seen = new Set<string>();
  const out: RemoteRef[] = [];
  for (const remote of remotes) {
    if (seen.has(remote.url)) continue;
    seen.add(remote.url);
    out.push(remote);
  }
  return out;
}

export function deriveTransport(
  packages: PackageRef[],
  remotes: RemoteRef[],
  hasCommand: boolean,
): TransportKind {
  if (remotes.length > 0 && (packages.length > 0 || hasCommand)) return "both";
  if (remotes.length > 0) return "remote";
  if (packages.length > 0 || hasCommand) return "stdio";
  return "unknown";
}

export function deriveInstall(
  packages: PackageRef[],
  remotes: RemoteRef[],
  command: string | null | undefined,
  args: string[] | undefined,
): InstallSnippet[] {
  const snippets: InstallSnippet[] = [];

  for (const pkg of packages) {
    const version = pkg.version ? `@${pkg.version}` : "";
    switch (pkg.registryType) {
      case "npm":
        snippets.push({ kind: "npx", command: "npx", args: ["-y", `${pkg.identifier}${version}`] });
        break;
      case "pypi":
        snippets.push({ kind: "uvx", command: "uvx", args: [pkg.identifier] });
        break;
      case "oci":
        snippets.push({ kind: "docker", command: "docker", args: ["run", "-i", "--rm", pkg.identifier] });
        break;
      default:
        snippets.push({
          kind: "command",
          command: pkg.identifier,
          args: [],
          note: pkg.registryType,
        });
    }
  }

  for (const remote of remotes) {
    snippets.push({ kind: "remote", url: remote.url, note: remote.type });
  }

  if (command) {
    snippets.push({
      kind: "command",
      command,
      args: args ?? [],
      note: "from local client config",
    });
  }

  const seen = new Set<string>();
  return snippets.filter((snippet) => {
    const key = JSON.stringify(snippet);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeGroup(group: RawServer[], fetchedAt: string): ServerRecord {
  // Source priority first; within one source, the most recently updated entry
  // wins. The registry returns history, so without this tiebreak an old version
  // could supply the description and version of a current server.
  const sorted = [...group].sort((a, b) => {
    const bySource = SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
    if (bySource !== 0) return bySource;
    const aTime = Date.parse(a.updatedAt ?? "") || 0;
    const bTime = Date.parse(b.updatedAt ?? "") || 0;
    return bTime - aTime;
  });
  const primary = sorted[0] as RawServer;

  const repo = canonicalRepo(primary.repoUrl) ?? firstRepo(sorted);
  const id =
    primary.id ??
    (repo ? `github:${repo.replace(/^github\.com\//, "")}` : `name:${slugify(primary.name)}`);

  const packages = dedupePackages(sorted.flatMap((entry) => entry.packages ?? []));
  const remotes = dedupeRemotes(sorted.flatMap((entry) => entry.remotes ?? []));
  const command = sorted.find((entry) => entry.command)?.command ?? null;
  const args = sorted.find((entry) => entry.args && entry.args.length > 0)?.args ?? [];

  const categories = uniqueStrings(sorted.flatMap((entry) => entry.categories ?? []));
  const runtimes = uniqueStrings(sorted.flatMap((entry) => entry.runtimes ?? []));

  const sources = Array.from(new Set(sorted.map((entry) => entry.source))).sort(
    (a, b) => SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b],
  );

  const name = firstText(sorted.map((entry) => entry.name), 120) ?? slugify(primary.name);

  return {
    id,
    name,
    title: firstText(sorted.map((entry) => entry.title), 200),
    description: firstText(sorted.map((entry) => entry.description), 800),
    homepage: firstText(sorted.map((entry) => entry.homepage), 400),
    repoUrl: primary.repoUrl ?? firstRepoUrl(sorted),
    version: firstText(sorted.map((entry) => entry.version), 64),
    status: "active",
    isOfficial: sorted.some((entry) => entry.isOfficial === true),
    transportKind: deriveTransport(packages, remotes, Boolean(command)),
    language: firstText(sorted.map((entry) => entry.language), 32),
    runtimes,
    categories,
    packages,
    remotes,
    install: deriveInstall(packages, remotes, command, args),
    source: primary.source,
    sources,
    fetchedAt,
    updatedAt: firstText(sorted.map((entry) => entry.updatedAt), 40),
    // Final choke point before persistence: no source may smuggle a token into
    // the `raw` column.
    raw: primary.raw === null || primary.raw === undefined ? null : redactDeep(primary.raw),
  };
}

function firstRepo(list: RawServer[]): string | null {
  for (const entry of list) {
    const repo = canonicalRepo(entry.repoUrl);
    if (repo) return repo;
  }
  return null;
}

function firstRepoUrl(list: RawServer[]): string | null {
  for (const entry of list) {
    const repo = canonicalRepo(entry.repoUrl);
    if (repo) return `https://${repo}`;
  }
  return null;
}

/**
 * Deduplicate and merge observations into catalog records.
 *
 * Two passes are needed: registry rows establish `repo -> id` before the
 * awesome rows (which only know a URL) are grouped, otherwise a server would
 * appear twice -- once under its reverse-DNS name, once under `github:o/r`.
 */
export function normalizeServers(
  raws: RawServer[],
  fetchedAt = new Date().toISOString(),
): ServerRecord[] {
  const repoToId = new Map<string, string>();
  for (const entry of raws) {
    const repo = canonicalRepo(entry.repoUrl);
    if (repo && entry.id) repoToId.set(repo, entry.id);
  }

  const groups = new Map<string, RawServer[]>();

  for (const entry of raws) {
    const repo = canonicalRepo(entry.repoUrl);
    const key =
      entry.id ??
      (repo ? repoToId.get(repo) : undefined) ??
      (repo ? `github:${repo.replace(/^github\.com\//, "")}` : `name:${slugify(entry.name)}`);

    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const records: ServerRecord[] = [];
  for (const group of groups.values()) {
    records.push(mergeGroup(group, fetchedAt));
  }

  return records.sort((a, b) => a.id.localeCompare(b.id));
}
