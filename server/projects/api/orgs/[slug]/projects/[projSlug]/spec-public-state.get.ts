import {
  getCurrentPublicVersion,
  readPublicSpecFiles,
} from "@su/spec-public-state";
import { readExistingSpecInput } from "@su/spec-tools-schemas";
import { parseQuery } from "@su/validation";

/**
 * Read the project's *current* public spec state. Backs the
 * `read_existing_spec` LLM tool.
 *
 * Returns the monotonic version (from the DB) alongside the canonical
 * file contents (from disk under `<projectRoot>/specs/`). Optional
 * `?name=` query filters to a single file — useful when the LLM only
 * needs `spec.md` and we'd rather not roundtrip the full bundle.
 *
 * Auth: `project-access` middleware. Published state is visible to
 * anyone with project access by design.
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const projectId = event.context.projectId!;
  const projectSlug = event.context.projectSlug!;

  const { name } = parseQuery(event, readExistingSpecInput);

  const [version, files] = await Promise.all([
    getCurrentPublicVersion(projectId),
    readPublicSpecFiles(orgId, projectSlug, { name }),
  ]);

  return { version, files };
});
