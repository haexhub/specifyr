import {
  getCurrentPublicVersion,
  readPublicSpecFiles,
} from "@su/spec-public-state";
import { readExistingSpecInput } from "#shared/utils/spec-tools-schemas";
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
 * Why not `Promise.all([version, files])`: under a concurrent publish
 * we could pair `version=N` with files from version N+1. Read version
 * → files → version again; retry the pair if the second version read
 * doesn't match. STABILIZE_RETRIES is small because each round-trip
 * is cheap and publish is rare; if we genuinely can't get a stable
 * snapshot we surface a 503 rather than lie.
 *
 * Auth: `project-access` middleware. Published state is visible to
 * anyone with project access by design.
 */
const STABILIZE_RETRIES = 5;

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const projectId = event.context.projectId!;
  const projectSlug = event.context.projectSlug!;

  const { name } = parseQuery(event, readExistingSpecInput);

  for (let attempt = 0; attempt < STABILIZE_RETRIES; attempt++) {
    const v1 = await getCurrentPublicVersion(projectId);
    const files = await readPublicSpecFiles(orgId, projectSlug, { name });
    const v2 = await getCurrentPublicVersion(projectId);
    if (v1 === v2) return { version: v1, files };
  }
  // Publish loop running this hot on a single project would be a
  // misuse. Surface explicitly instead of returning a possibly-stale
  // pair; the caller can retry.
  throw createError({
    statusCode: 503,
    statusMessage: "public spec state is changing too rapidly; retry",
  });
});
