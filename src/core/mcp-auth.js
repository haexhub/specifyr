/**
 * Pure helpers for MCP-server bearer-token auth, kept in src/core/ so
 * `node --test` can exercise them without a Nuxt/Nitro harness. The
 * request-bound wrapper lives in server/utils/mcp-auth.ts and re-exports
 * these.
 */

import { timingSafeEqual } from "node:crypto";

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Extract the bearer token from an Authorization header. Returns null
 * when the header is missing, empty, or doesn't follow the
 * `Bearer <token>` format.
 *
 * @param {string|null|undefined} header
 * @returns {string|null}
 */
export function extractBearer(header) {
  if (!header) return null;
  const match = String(header).trim().match(BEARER_RE);
  return match ? match[1] : null;
}

/**
 * Timing-safe compare two tokens. Returns false on length mismatch
 * (timingSafeEqual throws on length-mismatch, and we don't want to leak
 * length via "throws-vs-returns-false") OR on any byte mismatch.
 *
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
export function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
