import { and, count, eq, gte, inArray, isNull } from "drizzle-orm";
import { getDb } from "@db/client";
import {
  llmCredentials,
  orgMemberships,
  orgs,
  projects,
  runnerSessions,
  users,
} from "@db/schema";
import { requirePlatformAdmin } from "@su/platform-admin-auth";
import { listActiveCompanies } from "@su/company-manager";

/**
 * Aggregates a single platform-admin snapshot: tenant counts, recent
 * sign-ups, currently-active runner sessions and running companies.
 *
 * Single endpoint instead of one-per-card so the UI does a single
 * round-trip on /admin landing — the dashboard isn't polled, so the
 * cost of computing everything once per refresh is fine.
 */
export default defineEventHandler(async (event) => {
  await requirePlatformAdmin(event);

  const db = getDb();
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: "DB not configured" });
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [usersTotalRow] = await db.select({ total: count() }).from(users);
  const [usersNewRow] = await db
    .select({ total: count() })
    .from(users)
    .where(gte(users.createdAt, sevenDaysAgo));

  const [orgsTotalRow] = await db.select({ total: count() }).from(orgs);
  const [membershipsTotalRow] = await db
    .select({ total: count() })
    .from(orgMemberships);

  const [projectsTotalRow] = await db.select({ total: count() }).from(projects);

  const [sessionsActiveRow] = await db
    .select({ total: count() })
    .from(runnerSessions)
    .where(
      and(
        gte(runnerSessions.expiresAt, now),
        isNull(runnerSessions.revokedAt),
      ),
    );

  const credentialsByProviderRows = await db
    .select({
      provider: llmCredentials.provider,
      mode: llmCredentials.mode,
      total: count(),
    })
    .from(llmCredentials)
    .groupBy(llmCredentials.provider, llmCredentials.mode);

  type ProviderKey = "anthropic" | "openai" | "google" | "openrouter";
  const credentialsByProvider: Record<
    ProviderKey,
    { total: number; oauth: number; apiKey: number }
  > = {
    anthropic: { total: 0, oauth: 0, apiKey: 0 },
    openai: { total: 0, oauth: 0, apiKey: 0 },
    google: { total: 0, oauth: 0, apiKey: 0 },
    openrouter: { total: 0, oauth: 0, apiKey: 0 },
  };
  for (const row of credentialsByProviderRows) {
    const bucket = credentialsByProvider[row.provider as ProviderKey];
    if (!bucket) continue;
    const n = Number(row.total);
    bucket.total += n;
    if (row.mode === "oauth_claude") bucket.oauth += n;
    else if (row.mode === "api_key") bucket.apiKey += n;
  }

  // Running companies live in-process (CompanyRuntime registry). The
  // slug also doubles as project slug; resolve the owning org for
  // display so the operator can see who's running what.
  const activeEntries = listActiveCompanies();
  const projectRows = activeEntries.length
    ? await db
        .select({
          slug: projects.slug,
          ownerOrgId: projects.ownerOrgId,
          orgSlug: orgs.slug,
          orgName: orgs.name,
        })
        .from(projects)
        .leftJoin(orgs, eq(orgs.id, projects.ownerOrgId))
        .where(inArray(projects.slug, activeEntries.map(([s]) => s)))
    : [];
  const projectBySlug = new Map(projectRows.map((p) => [p.slug, p]));

  const runningCompanies = activeEntries.map(([slug, runtime]) => {
    const owner = projectBySlug.get(slug);
    let agentCount = 0;
    try {
      agentCount = runtime.listAgents().length;
    } catch {
      agentCount = 0;
    }
    return {
      slug,
      ceoRole: runtime.ceoRole,
      agentCount,
      orgSlug: owner?.orgSlug ?? null,
      orgName: owner?.orgName ?? null,
    };
  });

  const orgsTotal = Number(orgsTotalRow?.total ?? 0);
  const membershipsTotal = Number(membershipsTotalRow?.total ?? 0);

  return {
    users: {
      total: Number(usersTotalRow?.total ?? 0),
      newLast7d: Number(usersNewRow?.total ?? 0),
    },
    orgs: {
      total: orgsTotal,
      avgMembers: orgsTotal > 0
        ? Math.round((membershipsTotal / orgsTotal) * 10) / 10
        : 0,
    },
    projects: {
      total: Number(projectsTotalRow?.total ?? 0),
    },
    sessions: {
      active: Number(sessionsActiveRow?.total ?? 0),
    },
    runningCompanies,
    credentialsByProvider,
    generatedAt: now.toISOString(),
  };
});
