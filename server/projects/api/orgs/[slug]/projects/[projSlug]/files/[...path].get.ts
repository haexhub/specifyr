import fs, { constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { projectDir } from "@su/data-dirs";
import { projectRelativePath } from "#shared/utils/spec-tools-schemas";

/**
 * Read a single file from the project's working tree. Backs the
 * browser-side Speckit agent's `read_file` LLM tool.
 *
 * Security model — path traversal is THE boundary here:
 *
 *  1. Zod (`projectRelativePath`) rejects empty paths, leading `/`,
 *     and any `..` segment in the URL-decoded input.
 *  2. We `path.resolve(rootReal, relPath)` and check the result still
 *     lives under the project root — purely syntactic.
 *  3. `fs.open` with `O_RDONLY | O_NOFOLLOW` opens the file atomically,
 *     refusing the open if the LEAF component is a symlink (ELOOP).
 *     This binds the size check and the read to the same FileHandle,
 *     closing the TOCTOU race that an lstat→read sequence admits.
 *  4. After the file is open, we still `realpath(requested)` and check
 *     the result is rooted — defence against an intermediate symlinked
 *     directory (O_NOFOLLOW only protects the leaf).
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

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      requested,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw createError({ statusCode: 404, statusMessage: "not found" });
    }
    if (code === "ELOOP") {
      // O_NOFOLLOW: the path's leaf was a symlink.
      throw createError({
        statusCode: 400,
        statusMessage: "symlinks not allowed",
      });
    }
    if (code === "EISDIR") {
      throw createError({ statusCode: 400, statusMessage: "not a regular file" });
    }
    throw err;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw createError({ statusCode: 400, statusMessage: "not a regular file" });
    }
    if (stat.size > MAX_BYTES) {
      throw createError({
        statusCode: 413,
        statusMessage: `file too large (>${MAX_BYTES} bytes)`,
      });
    }

    // Intermediate-symlink check: O_NOFOLLOW only refused a leaf symlink.
    // A parent directory could still be a symlink that escapes the root,
    // so we resolve the full path and confirm it stays inside.
    const realFile = await fs.realpath(requested);
    if (realFile !== rootReal && !realFile.startsWith(rootReal + path.sep)) {
      throw createError({
        statusCode: 400,
        statusMessage: "path escapes project root via symlink",
      });
    }

    const buf = await handle.readFile();
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
  } finally {
    await handle.close();
  }
});
