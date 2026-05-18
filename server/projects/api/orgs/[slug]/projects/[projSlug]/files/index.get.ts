import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "@su/data-dirs";
import { listFilesInput } from "@su/spec-tools-schemas";
import { parseQuery } from "@su/validation";

/**
 * List files in the project's working tree, optionally filtered by a
 * glob. Backs the browser-side Speckit agent's `list_files` LLM tool.
 *
 * Hard caps the response at MAX_RESULTS and reports `truncated: true`
 * if the limit was hit — without that signal the LLM might assume the
 * list is exhaustive.
 *
 * Excludes:
 *   - `.git` and `node_modules` (noise, never useful for spec work)
 *   - symlinks (would be a path-traversal vector — see also Task 1.3)
 *
 * Auth: `project-access` middleware gates the URL and populates
 * event.context.{orgId, projectSlug}. We do not re-check membership
 * here.
 */
const MAX_RESULTS = 500;
const DEFAULT_GLOB = "**/*";
const IGNORED_TOP_LEVEL_DIRS = new Set([".git", "node_modules"]);

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const projectSlug = event.context.projectSlug!;
  const { glob } = parseQuery(event, listFilesInput);

  const root = projectDir(orgId, projectSlug);

  const pattern = glob ?? DEFAULT_GLOB;
  const out: Array<{ path: string; type: "file" | "directory" }> = [];
  let truncated = false;

  // Iterate fs.glob lazily so we can stop at MAX_RESULTS.
  // withFileTypes:true gives a Dirent per match (no extra stat needed
  // for the type discriminator).
  for await (const dirent of fs.glob(pattern, {
    cwd: root,
    withFileTypes: true,
    exclude: (d) =>
      d.parentPath === root && IGNORED_TOP_LEVEL_DIRS.has(d.name),
  })) {
    if (out.length >= MAX_RESULTS) {
      truncated = true;
      break;
    }
    if (dirent.isSymbolicLink()) continue;

    let type: "file" | "directory";
    if (dirent.isFile()) type = "file";
    else if (dirent.isDirectory()) type = "directory";
    else continue; // sockets, fifos, etc.

    // Compose the project-relative path. Dirent.parentPath is absolute;
    // path.relative against root yields the relative parent.
    const parentRel = path.relative(root, dirent.parentPath);
    const relPath = parentRel === "" ? dirent.name : path.join(parentRel, dirent.name);
    out.push({ path: relPath, type });
  }

  return { files: out, truncated };
});
