/**
 * Shared domain types.
 *
 * Everything that originates from a remote registry or a markdown list is
 * untrusted text: it is stored as-is for fidelity but must be passed through
 * `security/sanitize.ts` before it is shown to a human or a model.
 */

export type SourceName = "registry" | "awesome" | "local";

export type TransportKind = "stdio" | "remote" | "both" | "unknown";

export interface PackageRef {
  /** e.g. "npm", "pypi", "oci" */
  registryType: string;
  /** package name, image reference, etc. */
  identifier: string;
  version?: string;
  transport?: string;
  runtimeHint?: string;
}

export interface RemoteRef {
  /** e.g. "streamable-http", "sse" */
  type: string;
  url: string;
  /** Header *names* only. Values are never stored. */
  headerNames?: string[];
}

export type InstallKind = "npx" | "uvx" | "docker" | "remote" | "command";

export interface InstallSnippet {
  kind: InstallKind;
  /** The command to run, when local. */
  command?: string;
  args?: string[];
  /** The endpoint, when remote. */
  url?: string;
  note?: string;
}

/** A single un-normalized observation from one source. */
export interface RawServer {
  source: SourceName;
  /** Present when the source supplies a canonical id (e.g. registry name). */
  id?: string;
  name: string;
  title?: string | null;
  description?: string | null;
  homepage?: string | null;
  repoUrl?: string | null;
  version?: string | null;
  isOfficial?: boolean;
  language?: string | null;
  runtimes?: string[];
  categories?: string[];
  packages?: PackageRef[];
  remotes?: RemoteRef[];
  updatedAt?: string | null;
  /** Local client configs only: the launch command. */
  command?: string | null;
  args?: string[];
  /** Local client configs only: env *names*, never values. */
  envNames?: string[];
  raw?: unknown;
}

/** A deduplicated, normalized catalog entry. */
export interface ServerRecord {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  homepage: string | null;
  repoUrl: string | null;
  version: string | null;
  status: string;
  isOfficial: boolean;
  transportKind: TransportKind;
  language: string | null;
  runtimes: string[];
  categories: string[];
  packages: PackageRef[];
  remotes: RemoteRef[];
  install: InstallSnippet[];
  /** Highest-priority source that contributed. */
  source: SourceName;
  /** Every source that contributed. */
  sources: SourceName[];
  fetchedAt: string;
  updatedAt: string | null;
  raw: unknown;
}

export interface SearchOptions {
  query?: string;
  category?: string;
  transport?: TransportKind;
  language?: string;
  officialOnly?: boolean;
  limit?: number;
  offset?: number;
  matchAll?: boolean;
}

export interface SearchHit extends ServerRecord {
  score: number;
  highlight: string | null;
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  sources: Record<
    SourceName,
    { fetched: number; error?: string }
  >;
  normalized: number;
  inserted: number;
  updated: number;
  durationMs: number;
}
