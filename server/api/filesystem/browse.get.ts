import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

export interface FilesystemEntry {
  name: string;
  type: "dir";
  hasExtensionYml: boolean;
}

export interface FilesystemBrowseResponse {
  path: string;
  parent: string | null;
  entries: FilesystemEntry[];
  /** Does the current directory itself contain an extension.yml? */
  hasExtensionYml: boolean;
  /** Quick-jump locations for the UI. */
  bookmarks: { label: string; path: string }[];
}

/**
 * Directory browser for the Local-Extensions picker. Lists subdirectories only
 * (files are noise when picking an extension root) and flags dirs that contain
 * an extension.yml so the user can visually locate valid extension folders.
 *
 * No path sandboxing: this app runs locally as a dev tool with full user
 * permissions, same trust level as the existing registration endpoint.
 */
export default defineEventHandler(async (event): Promise<FilesystemBrowseResponse> => {
  const query = getQuery(event);
  const rawPath = typeof query.path === "string" ? query.path : "";
  const target = rawPath.trim() ? path.resolve(rawPath) : os.homedir();

  let stat;
  try {
    stat = await fs.stat(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw createError({
      statusCode: code === "ENOENT" ? 404 : 500,
      statusMessage:
        code === "ENOENT"
          ? `path does not exist: ${target}`
          : `cannot read path: ${(err as Error).message}`
    });
  }
  if (!stat.isDirectory()) {
    throw createError({ statusCode: 400, statusMessage: `not a directory: ${target}` });
  }

  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw createError({
      statusCode: code === "EACCES" ? 403 : 500,
      statusMessage:
        code === "EACCES"
          ? `permission denied: ${target}`
          : `cannot list directory: ${(err as Error).message}`
    });
  }

  const dirs = dirents
    .filter((d) => d.isDirectory())
    // Hide hidden dirs by default — user can navigate in by typing the path
    .filter((d) => !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  // Probe each subdir for extension.yml. Done in parallel but bounded by how
  // many entries exist — dir fan-out on most dev machines is small enough to
  // make this negligible (<100 entries).
  const entries: FilesystemEntry[] = await Promise.all(
    dirs.map(async (name) => {
      const ymlPath = path.join(target, name, "extension.yml");
      const hasExtensionYml = await fs
        .access(ymlPath, fs.constants.R_OK)
        .then(() => true)
        .catch(() => false);
      return { name, type: "dir" as const, hasExtensionYml };
    })
  );

  const hasExtensionYml = await fs
    .access(path.join(target, "extension.yml"), fs.constants.R_OK)
    .then(() => true)
    .catch(() => false);

  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    entries,
    hasExtensionYml,
    bookmarks: [
      { label: "Home", path: os.homedir() },
      { label: "App-CWD", path: process.cwd() }
    ]
  };
});
