import { defineConfig } from "vitest/config";

/**
 * Vitest config for API e2e tests. Boots a real Nuxt+Nitro server
 * via @nuxt/test-utils/e2e and sends real HTTP requests against it.
 *
 * Why a separate runner from node:test:
 * - @nuxt/test-utils is Vitest-coupled; reusing it from node:test
 *   would mean orchestrating the Nuxt boot manually.
 * - Vitest gives us per-file isolation + concurrent worker pools that
 *   node:test handles awkwardly when sharing a server.
 *
 * Unit tests (DB-touching, no HTTP) stay on node:test for speed.
 */
export default defineConfig({
  test: {
    include: ["tests/api/**/*.test.ts"],
    // E2E tests share a single Nuxt server (booted in setup() once),
    // so they need to run sequentially within a file.
    pool: "forks",
    // One worker = one Nuxt boot per file. More workers = more boots
    // = slower. singleFork shares cold-start cost across all tests.
    poolMatchGlobs: undefined,
    fileParallelism: false,
    // The Nuxt boot is ~10s on this box; default 5s is too low.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
