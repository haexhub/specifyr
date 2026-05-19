/**
 * Programmatic test discovery for node:test.
 *
 * Why this exists: Node's `--test` default file pattern matches only
 * `.js`/`.cjs`/`.mjs`. Our DB-touching tests are `.ts` (so `tsx` can
 * strip types on import). Globbing via the shell breaks because pnpm
 * scripts go through POSIX `sh -c` (no globstar) and quoted globs
 * aren't expanded.
 */

import { run } from "node:test";
import { spec } from "node:test/reporters";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TEST_EXT = /\.test\.(?:js|ts|mjs|cjs)$/;

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // tests/api/ and tests/unit/ are Vitest-driven and run from
      // their own configs (vitest.config.ts / vitest.unit.config.ts).
      // `pnpm test` chains them via `test:unit && test:node`, so they
      // are NOT skipped — they're just outside this runner's scope.
      if (entry.name === "api" || entry.name === "unit") continue;
      await walk(p, out);
    } else if (TEST_EXT.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const files = (await walk("tests")).sort();

let passed = 0;
let failed = 0;
let skipped = 0;
const start = Date.now();

const stream = run({ files, concurrency: 1 });
stream.on("test:pass", (e) => {
  if (e.skip) skipped++;
  else passed++;
});
stream.on("test:fail", () => {
  failed++;
});
stream.compose(new spec()).pipe(process.stdout);
stream.once("end", () => {
  const dur = ((Date.now() - start) / 1000).toFixed(2);
  console.log(
    `\n— ${files.length} files | ${passed} passed | ${failed} failed | ${skipped} skipped | ${dur}s —`,
  );
  process.exit(failed > 0 ? 1 : 0);
});
