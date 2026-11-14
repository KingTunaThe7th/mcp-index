#!/usr/bin/env node
/**
 * Copy non-TypeScript assets that the runtime reads from disk into dist/.
 * `tsc` only emits .js/.d.ts, so `src/db/schema.sql` needs this step.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = ["src/db/schema.sql"];

for (const relative of assets) {
  const from = resolve(root, relative);
  const to = resolve(root, "dist", relative.replace(/^src\//, ""));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  process.stdout.write(`copied ${relative} -> ${to.replace(`${root}/`, "")}\n`);
}
