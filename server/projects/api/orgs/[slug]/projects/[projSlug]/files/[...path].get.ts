import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "@su/data-dirs";
import { projectRelativePath } from "@su/spec-tools-schemas";

/**
 * Read a single file from the project's working tree. Backs the
 * browser-side Speckit agent's `read_file` LLM tool.
 *
 * Security model — path traversal is THE boundary here:
 *
 *  1. Zod (`projectRelativePath`) rejects empty paths, leading `/`,
 *     and any `..` segment in the URL-decoded input.
 *  2. We `path.resolve(rootReal, relPath)` and re-check the result
 *     still lives under the project root — catches edge cases the
 *     Zod check doesn't see (e.g. a fresh attack vector before we
 *     tighten the schema).
 *  3. `fs.lstat` is used (NOT stat) so we can detect symlinks BEFORE
 *     following them, and reject any symlink outright. Following
 *     them and then comparing realpaths would also work but admits
 *     a TOCTOU race where the target changes between the realpath
 *     check and the read.
 *  4. After lstat says "regular file" we still realpath the file
 *     and confirm the result is rooted at the project — belt-and-
 *     braces against an intermediate symlinked directory.
 *
 * The 1 MiB cap is a sanity bound. The LLM cannot usefully digest
 * a multi-megabyte file in one call anyway; if a legitimate use
 * case turns up we can lift it then.
 *
 * Auth: `project-access` middleware gates the URL and populates
 * event.context.{orgId, projectSlug}.
 */
const MAX_BYTES = 1_000_000;

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const projectSlug = event.context.projectSlug!;

  // Nitro decodes %2F as `/` before splitting [...path], so the captured
  // value is already the URL-decoded project-relative path (slashes intact).
  const rawPath = getRouterParam(event, "path");
  const parsed = projectRelativePath.safeParse(rawPath);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.issues[0]?.message ?? "invalid path",
    });
  }
  const relPath = parsed.data;

  // Resolve the project root via realpath so symlinked tmpdirs (common
  // on macOS where /var → /private/var) don't trip the rooted-path check.
  const rootReal = await fs.realpath(projectDir(orgId, projectSlug));
  const requested = path.resolve(rootReal, relPath);
  if (requested !== rootReal && !requested.startsWith(rootReal + path.sep)) {
    throw createError({
      statusCode: 400,
      statusMessage: "path escapes project root",
    });
  }

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(requested);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw createError({ statusCode: 404, statusMessage: "not found" });
    }
    throw err;
  }

  if (stat.isSymbolicLink()) {
    throw createError({
      statusCode: 400,
      statusMessage: "symlinks not allowed",
    });
  }
  if (!stat.isFile()) {
    throw createError({ statusCode: 400, statusMessage: "not a regular file" });
  }
  if (stat.size > MAX_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `file too large (>${MAX_BYTES} bytes)`,
    });
  }

  const realFile = await fs.realpath(requested);
  if (realFile !== rootReal && !realFile.startsWith(rootReal + path.sep)) {
    throw createError({
      statusCode: 400,
      statusMessage: "path escapes project root via symlink",
    });
  }

  const buf = await fs.readFile(realFile);
  // Heuristic: null-byte = binary by convention. For null-free buffers
  // try strict UTF-8 decode; failure falls through to base64. Keeps the
  // happy path (markdown / code) lean.
  if (!buf.includes(0)) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      return { content: decoded, encoding: "utf-8" as const };
    } catch {
      // not valid utf-8 → fall through
    }
  }
  return { content: buf.toString("base64"), encoding: "base64" as const };
});
