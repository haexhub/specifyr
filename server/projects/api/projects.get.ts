import { inArray } from "drizzle-orm";
import { getDb } from "@db/client";
import { orgs } from "@db/schema";
import { createOrchestrator } from "@su/orchestrator";
import { listProjectKeysForUser } from "@su/project-store";

/**
 * Lists every project the current user can access across all of their
 * orgs. Used by the global project sidebar.
 *
 * Access rule: caller sees a project iff they are an admin of the owning
 * org OR an explicit project member (see project-store.listProjectKeysForUser).
 * The response includes `orgSlug` so the UI can build org-scoped links.
 *
 * Legacy fallback: when there's no userId (auth disabled or middleware
 * didn't attach one), return the full FS-discovered list so the
 * single-user dev/test setup keeps working.
 */
export default defineEventHandler(async (event) => {
  const orchestrator = await createOrchestrator();
  const all = (await orchestrator.listProjects()) as Array<{
    orgId: string;
    slug: string;
  }>;

  const userId = event.context.userId;
  if (!userId) return all;

  const ownedKeys = await listProjectKeysForUser(userId);
  const ownedSet = new Set(ownedKeys.map((k) => `${k.orgId}/${k.slug}`));
  const filtered = all.filter((p) => ownedSet.has(`${p.orgId}/${p.slug}`));

  // Enrich with the org slug so the UI can build /specs/<orgSlug>/<projSlug>
  // links without a second roundtrip per project.
  const db = getDb();
  if (!db || filtered.length === 0) return filtered;
  const orgIds = [...new Set(filtered.map((p) => p.orgId))];
  const orgRows = await db
    .select({ id: orgs.id, slug: orgs.slug })
    .from(orgs)
    .where(inArray(orgs.id, orgIds));
  const slugByOrgId = new Map(orgRows.map((o) => [o.id, o.slug]));
  return filtered.map((p) => ({ ...p, orgSlug: slugByOrgId.get(p.orgId) ?? null }));
});
