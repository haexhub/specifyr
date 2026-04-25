import path from "node:path";
import fs from "node:fs/promises";
import { projectCwd } from "../../../utils/specops-stores";

/**
 * Read a file or list a directory inside a project's working tree.
 *
 * Security: the requested path must resolve to a location *inside* the
 * project's own directory — any attempt to escape (via `..` or absolute paths)
 * is rejected with a 400.
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const query = getQuery(event);
  const relRaw = typeof query.path === "string" ? query.path : "";
  const rel = relRaw.replace(/^\/+/, ""); // drop leading slashes so path.resolve keeps it relative

  const root = projectCwd(slug);
  const absolute = path.resolve(root, rel);

  // Ensure target is strictly inside root (plus root itself when rel is empty)
  const relativeCheck = path.relative(root, absolute);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    throw createError({ statusCode: 400, statusMessage: "Path escapes project root" });
  }

  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw createError({ statusCode: 404, statusMessage: `Not found: ${rel || "(root)"}` });
    }
    throw err;
  }

  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    return {
      type: "dir",
      path: rel,
      entries: entries
        .map((entry) => ({
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory()
        }))
        .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
    };
  }

  if (!stat.isFile()) {
    throw createError({ statusCode: 400, statusMessage: "Path is neither file nor directory" });
  }

  // Hard cap to protect the UI from opening giant files.
  const MAX_BYTES = 2 * 1024 * 1024;
  if (stat.size > MAX_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `File too large (${stat.size} bytes, max ${MAX_BYTES})`
    });
  }

  const content = await fs.readFile(absolute, "utf8");
  return {
    type: "file",
    path: rel,
    size: stat.size,
    mtime: stat.mtimeMs,
    content
  };
});
