const SCHEME = "specifyr";
const VERSION = "1";
const SEP = ":";

function assertSafe(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.includes(SEP)) {
    throw new Error(`${field} must not contain the separator '${SEP}'`);
  }
}

export function encodeSessionId({ slug, stepId, sid }) {
  assertSafe(slug, "slug");
  assertSafe(stepId, "stepId");
  assertSafe(sid, "sid");
  return [SCHEME, VERSION, slug, stepId, sid].join(SEP);
}

export function decodeSessionId(id) {
  if (typeof id !== "string") throw new Error("malformed session-id: not a string");
  const parts = id.split(SEP);
  if (parts.length !== 5) throw new Error(`malformed session-id: expected 5 parts, got ${parts.length}`);
  const [scheme, version, slug, stepId, sid] = parts;
  if (scheme !== SCHEME) throw new Error(`unknown scheme '${scheme}'`);
  if (version !== VERSION) throw new Error(`unsupported version '${version}'`);
  return { slug, stepId, sid };
}
