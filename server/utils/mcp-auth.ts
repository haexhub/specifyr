/**
 * Bearer-token auth for the company-ops MCP endpoints.
 *
 * Workers run in isolated containers and call back to speculoss via HTTP
 * for capability authorization, agent lookup, and (later) sub-task
 * dispatch. The runtime mints a 32-byte token at construction and
 * injects it into worker containers as COMPANY_OPS_TOKEN. Endpoints
 * verify the bearer matches the active runtime for the slug.
 *
 * Threat model (single-host, solo-dev): bearer is sufficient. No mTLS.
 * The `companies` docker network already isolates traffic from outside,
 * and any attacker who can already reach the network has docker-socket
 * access (root on host) — bigger problems than auth bypass.
 *
 * Returns the runtime on success, throws createError(401/404) otherwise.
 * Uses timing-safe comparison so tokens can't be probed byte-by-byte.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { getActiveCompany } from "./company-manager";

// Pure helpers live in src/core/mcp-auth.js so node --test can exercise
// them without a Nuxt/Nitro harness. Lazy-loaded on first request to
// match the loader pattern used by company-manager.ts and friends —
// keeps the import graph evaluation non-blocking.
let _mcpAuthMod: {
  extractBearer: (h: string | null | undefined) => string | null;
  tokensMatch: (p: string, e: string) => boolean;
} | null = null;

async function loadMcpAuth() {
  if (_mcpAuthMod) return _mcpAuthMod;
  const url = pathToFileURL(path.join(process.cwd(), "src/core/mcp-auth.js")).href;
  _mcpAuthMod = (await import(url)) as typeof _mcpAuthMod;
  return _mcpAuthMod!;
}

export async function requireRuntimeAuth(event: any, slug: string) {
  const runtime = getActiveCompany(slug);
  if (!runtime) {
    throw createError({
      statusCode: 404,
      statusMessage: `No company runtime running for project '${slug}'`,
    });
  }

  const { extractBearer, tokensMatch } = await loadMcpAuth();

  const provided = extractBearer(getRequestHeader(event, "authorization"));
  if (!provided) {
    throw createError({
      statusCode: 401,
      statusMessage: "Missing or malformed Authorization header (expected 'Bearer <token>')",
    });
  }
  if (!tokensMatch(provided, runtime.opsToken)) {
    throw createError({ statusCode: 401, statusMessage: "Invalid token" });
  }

  return runtime;
}
