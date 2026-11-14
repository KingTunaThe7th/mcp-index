/**
 * Sync pipeline: fetch every enabled source, normalize, write.
 *
 * A failing source is reported and skipped rather than aborting the run: the
 * registry being down should not wipe your index. Source errors are surfaced in
 * the `SyncReport` so `mcp-index sync` can exit non-zero when everything failed.
 */
import { getStats, setMeta, upsertServerRecords } from "../db/index.js";
import type { DatabaseSync } from "../db/index.js";
import type { RawServer, SourceName, SyncReport } from "../types.js";
import { normalizeServers } from "./normalize.js";
import { fetchRegistryServers } from "../sources/registry.js";
import { fetchAwesomeServers } from "../sources/awesome.js";
import { localServersToRaw, readLocalConfigs } from "../sources/local.js";

export interface SyncOptions {
  sources?: SourceName[];
  registryUrl?: string;
  awesomeUrl?: string;
  localConfigs?: string[];
  signal?: AbortSignal;
}

export async function runSync(
  db: DatabaseSync,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const enabled = new Set<SourceName>(options.sources ?? ["registry", "awesome", "local"]);

  const report: SyncReport = {
    startedAt,
    finishedAt: startedAt,
    sources: {
      registry: { fetched: 0 },
      awesome: { fetched: 0 },
      local: { fetched: 0 },
    },
    normalized: 0,
    inserted: 0,
    updated: 0,
    durationMs: 0,
  };

  const raws: RawServer[] = [];

  const collect = async (
    source: SourceName,
    loader: () => Promise<RawServer[]>,
  ): Promise<void> => {
    if (!enabled.has(source)) return;
    try {
      const entries = await loader();
      report.sources[source].fetched = entries.length;
      raws.push(...entries);
    } catch (error) {
      report.sources[source].error =
        error instanceof Error ? error.message : String(error);
    }
  };

  await collect("registry", () =>
    fetchRegistryServers({
      ...(options.registryUrl ? { baseUrl: options.registryUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  );
  await collect("awesome", () => fetchAwesomeServers(options.awesomeUrl));
  await collect("local", async () =>
    localServersToRaw(readLocalConfigs(options.localConfigs)),
  );

  if (raws.length === 0) {
    const failures = Object.entries(report.sources)
      .filter(([, value]) => value.error)
      .map(([name, value]) => `${name}: ${value.error}`);
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    if (failures.length > 0) {
      throw new Error(`every source failed:\n${failures.join("\n")}`);
    }
    return report;
  }

  const records = normalizeServers(raws, startedAt);
  const { inserted, updated } = upsertServerRecords(db, records);

  setMeta(db, "last_sync", startedAt);
  setMeta(db, "last_sync_report", JSON.stringify(report));

  report.normalized = records.length;
  report.inserted = inserted;
  report.updated = updated;
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;

  const stats = getStats(db);
  setMeta(db, "last_sync_total", String(stats.total));

  return report;
}
