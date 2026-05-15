# Org-Scoped Projects Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

---

## Status (2026-05-15)

**Branch:** `feat/org-scoped-projects` → **PR #70**
https://github.com/haexhub/specifyr/pull/70

| Phase | Status | Notes |
| --- | --- | --- |
| Phase 0 — Branch + Pre-Flight | ✅ done | |
| Phase 1 — DB schema | ✅ done | Migration `0009_loose_the_fury.sql` |
| Phase 2 — FS path helpers + ArtifactStore | ✅ done | |
| Phase 3 — Project-Store + Access Middleware | ✅ done | |
| Phase 4 — API Route Restructuring | ✅ done | Plus per-project membership (extension of original plan, see below) |
| Phase 5 — UI | ✅ done | Plus 3 composables (`useProjectContext`, `useProject`, `useStepStates`) |
| Phase 6.3 — Test fixture updates | ✅ done | secrets-store + orchestrator + turn-broker-acp now thread orgId; 370/370 unit, 32/32 e2e |
| Phase 6.1 — Wipe demo data | ⏳ user-initiated | Destructive — see Task 6.1 |
| Phase 6.2 — Manual smoke test | ⏳ user-driven | Browser walkthrough — see Task 6.2 |

### Extension to original plan: per-project membership

User-requested mid-execution. Adds a per-project access-control layer on top of org-membership:

- New table `project_memberships(project_id, user_id)`, migration `0010_known_energizer.sql`.
- Access rule: **org admin** has implicit access to all projects; **org member** needs an explicit `project_memberships` row.
- Project creator is auto-added as project member at create time.
- New helpers in `project-store.ts`: `canUserAccessProject`, `addProjectMember`, `removeProjectMember`, `listProjectMembers`, plus `listProjectKeysForUser` rewritten to join via either role.
- Project-access middleware now enforces it on every `/api/orgs/.../projects/...` route.
- New CRUD endpoints `/api/orgs/<orgSlug>/projects/<projSlug>/members` (GET = anyone with access, POST/DELETE = org admin only).
- `userOwnsProject` removed (replaced by `canUserAccessProject`).
- `ProjectCreateDialog`: only org admins can create.

### Company-runtime registry rework (fallout from slug uniqueness)

- Registry now keyed by `${orgId}/${slug}` instead of just `slug`.
- `getActiveCompany`, `registerCompany`, `deregisterCompany`, `markCompanyStarting`, `clearCompanyStarting`, `isCompanyStarting` all take `(orgId, slug)` now.
- `listActiveCompanies()` returns `RegisteredCompany[]` (each entry has `runtime`, `orgId`, `orgSlug`, `slug`).
- New `findCompanyBySlugForMcp(slug)` for the worker→server MCP callback (workers don't know `orgId`; token disambiguates).
- `getOrgInitStatusForProjectSlug(slug)` → `getOrgInitStatus(orgId)`.
- Admin overview, approvals endpoints (`pending.get.ts`, `[id].get.ts`) consume the new shape and surface `orgSlug` to clients.

### Composables (Phase 5 follow-up)

`app/composables/`:
- `useProjectContext()` — pulls `orgSlug`/`projSlug` from `route.params`, exposes `apiBase`/`routeBase`/`cacheKey`.
- `useProject()` — fetches the project snapshot, exposes `project`/`workflow`/`workflowSteps`.
- `useStepStates(workflowSteps)` — fetches step states, derives `statusMap`.

All spec pages (`index`, `run`, `runtime`, `history`, `secrets`, `steps/[stepId]`) consume them.

### Test status (2026-05-15)

- **`pnpm test:e2e`** (with `DATABASE_URL=postgres://postgres:devpw@localhost:5566/specifyr`): 32/32 green. The route-collision fix renamed the new tree's first segment from `[orgSlug]` to `[slug]` so Nitro can merge it with the pre-existing `server/api/orgs/[slug]/...` tree (both must use the same param name at the same URL position).
- **`pnpm test`**: 370/370 pass. Fixtures previously failing on `(orgId, slug)`-keyed APIs are now updated:
   - `tests/db/secrets-store.test.ts` — threads `orgId` into `setSecret`/`getProjectSecrets`/`deleteSecret`/`listSecretKeys`.
   - `tests/orchestrator.test.js` — threads `orgId` through `SpecOrchestrator` methods and the legacy `createUiHandler` URL (now `/api/orgs/<orgId>/projects/<slug>`).
   - `tests/core/turn-broker-acp.test.js` — threads `orgId` through `SessionStore.createSession`, `TurnBroker.startTurn`, and the `running` Map key (`${orgId}|${slug}|${stepId}|${sid}`).

### Handoff — what's left for the next session

1. **Phase 6.1 — wipe demo data** (destructive; user-initiated):
   ```bash
   rm -rf ~/.specifyr/.specifyr ~/.specifyr/projects
   docker exec -i specifyr-postgres-dev psql -U postgres -d specifyr -c "TRUNCATE TABLE projects CASCADE;"
   ```
2. **Phase 6.2 — manual smoke test in the browser** (test plan in Task 6.2 below). Pay special attention to:
   - Two orgs with a project of the same slug → both work, FS shows two `<orgId>/` dirs.
   - Org-admin vs org-member access to `/specs/<orgSlug>/<projSlug>/...` URLs.
   - Member-management UI (does not yet exist in the UI — endpoints are there, frontend is TODO).
   - Approval deep-link goes to the right project.
3. **Open work — not blocking this PR:**
   - Member-management UI: list/add/remove project members in the project's settings tab. Endpoints already wired (`/api/orgs/<orgSlug>/projects/<projSlug>/members` GET/POST/DELETE).
   - Migration journal robustness: I had to manually re-insert a journal row when drizzle-kit migrate appeared to silently fail mid-apply on a fresh DB. Worth investigating whether the dev startup migrator is enough or if drizzle-kit migrate has a real bug here.
   - Org-scoping for the new git-remote-sync feature (PR #68, merged from main): `project-repository.ts` writes meta.json under the old slug-only path; routes + tests still use the single-slug API. Already retrofitted as part of the merge — see commits after the merge.

---

**Goal:** Make project slugs unique per-org (not platform-wide), restructure URLs to `/specs/<orgSlug>/<projSlug>` and FS to `~/.specifyr/projects/<orgId>/<projSlug>/`. Single tenant boundary at the org level for both DB and disk, enabling future per-org filesystem / sharding.

**Architecture:**
- **DB:** drop `projects.slug UNIQUE`, replace with composite `UNIQUE (owner_org_id, slug)`. All project lookups become `(orgId, slug)`.
- **FS:** add an `<orgId>` segment between `dataDir()` and the project slug. `~/.specifyr/projects/<orgId>/<projSlug>/` and `~/.specifyr/.specifyr/<orgId>/<projSlug>/`. Org-id (UUID) chosen over org-slug because (a) it's stable across renames, (b) future per-org volume mounts can pin to it cleanly.
- **API:** move `/api/projects/[slug]/*` → `/api/orgs/[orgSlug]/projects/[projSlug]/*`. A new project-access middleware resolves `orgSlug+projSlug` → attaches `event.context.orgId`, `event.context.projectSlug` to downstream handlers, and gates by org-membership. Handlers stop calling `getProjectFromDb` / `userOwnsProject` themselves.
- **UI:** routes move to `/specs/[orgSlug]/[projSlug]/*`. Project list sidebar groups by org. NuxtLinks and `useFetch` URLs updated.
- **No data migration.** All demo data on the dev machine is disposable. The cleanup step (`rm -rf ~/.specifyr/.specifyr ~/.specifyr/projects` + truncate `projects` table) is the first thing executed when the new code is ready.
- **Bonus fix (orphan detection):** in the new `createProjectRecord`, if FS dirs exist but no DB row owns them, clean them up before creating. Eliminates the orphaned-directory class of bugs.

**Tech Stack:** Drizzle ORM, PostgreSQL, Nuxt 3 file-based routing, Vue 3, Node `fs/promises`.

**Out of scope:**
- Data migration of existing projects (demo-only, will be wiped).
- Cross-org project access (sharing). Single owning org per project, no sharing model.
- Soft-delete or tombstones (handled at FS+DB rm).
- Renaming `orgs.slug` post-create (still treated as effectively immutable; FS uses orgId precisely so a future rename feature is decoupled from disk).
- Internationalising any new strings beyond what currently exists.

---

## Phase 0 — Branch + Pre-Flight

### Task 0.1: Create feature branch

**Files:** none

**Step 1: Branch off main**

```bash
git fetch origin
git checkout main
git pull --ff-only
git checkout -b feat/org-scoped-projects
```

**Step 2: Confirm clean state**

```bash
git status
```

Expected: `working tree clean`.

---

### Task 0.2: Confirm dev DB + container are running

**Files:** none

**Step 1: Check containers**

```bash
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "postgres|specifyr-postgres"
```

Expected: `specifyr-postgres-dev` Up and healthy.

**Step 2: Confirm schema is current**

```bash
pnpm drizzle-kit migrate
```

Expected: no pending migrations (already applied). Bail out if errors — fix migrations before continuing.

---

## Phase 1 — DB Schema

### Task 1.1: Update `projects` table — composite uniqueness

**Files:**
- Modify: [server/shared/database/schema.ts:113-126](server/shared/database/schema.ts#L113-L126)

**Step 1: Replace inline `.unique()` with composite constraint**

Current:
```ts
slug: text("slug").notNull().unique(),
```

New:
```ts
slug: text("slug").notNull(),
```

In the table options callback, add:
```ts
(t) => ({
  ownerOrgIdx: index("projects_owner_org_idx").on(t.ownerOrgId),
  ownerOrgSlugUq: unique("projects_owner_org_slug_uq").on(t.ownerOrgId, t.slug),
}),
```

`unique` is already imported (line 16). No new imports needed.

**Step 2: Generate the migration**

```bash
pnpm drizzle-kit generate
```

Expected: a new migration file under `server/shared/database/migrations/` that DROPs the old `projects_slug_unique` and ADDs `projects_owner_org_slug_uq`. **Do not hand-edit the SQL** (per [Memory: drizzle migrations are generated, not hand-written](feedback_drizzle_migrations.md)).

**Step 3: Inspect generated SQL**

```bash
ls -lt server/shared/database/migrations/ | head -3
```

Open the newest `.sql` file. Verify it contains both:
- `ALTER TABLE "projects" DROP CONSTRAINT "projects_slug_unique";` (name may vary — whatever the prior unique was called)
- `ADD CONSTRAINT "projects_owner_org_slug_uq" UNIQUE ("owner_org_id","slug");`

If anything else changed unexpectedly, abort and investigate.

**Step 4: Commit**

```bash
git add server/shared/database/schema.ts server/shared/database/migrations/
git commit -m "feat(db): make project slug unique per org (composite constraint)"
```

---

## Phase 2 — FS Path Helpers + ArtifactStore

### Task 2.1: Extend data-dirs helpers with orgId

**Files:**
- Modify: [server/shared/utils/data-dirs.ts:21-23](server/shared/utils/data-dirs.ts#L21-L23)

**Step 1: Change signatures to take orgId + slug**

Replace `projectsDir()` and `hostProjectsDir()` with:
```ts
export function projectsRoot(): string {
  return process.env.SPECIFYR_PROJECTS_DIR ?? path.join(dataDir(), "projects");
}

export function orgProjectsDir(orgId: string): string {
  return path.join(projectsRoot(), orgId);
}

export function projectDir(orgId: string, slug: string): string {
  return path.join(orgProjectsDir(orgId), slug);
}

export function hostProjectsRoot(): string {
  if (process.env.SPECIFYR_HOST_PROJECTS_DIR) return process.env.SPECIFYR_HOST_PROJECTS_DIR;
  if (process.env.SPECIFYR_HOST_DATA_DIR) return path.join(process.env.SPECIFYR_HOST_DATA_DIR, "projects");
  return projectsRoot();
}

export function hostProjectDir(orgId: string, slug: string): string {
  return path.join(hostProjectsRoot(), orgId, slug);
}

export function artifactsRoot(): string {
  return path.join(dataDir(), ".specifyr");
}

export function orgArtifactsDir(orgId: string): string {
  return path.join(artifactsRoot(), orgId);
}

export function projectArtifactsDir(orgId: string, slug: string): string {
  return path.join(orgArtifactsDir(orgId), slug);
}
```

Delete the old `projectsDir()` and `hostProjectsDir()` exports — we want every call site to fail compilation so nothing slips through silently.

**Step 2: Verify compilation breaks at expected sites**

```bash
pnpm exec tsc --noEmit 2>&1 | grep -E "projectsDir|hostProjectsDir" | head -20
```

Expected: errors at ~5-8 call sites. Note them down — they're handled in Task 2.2.

**Step 3: Commit**

```bash
git add server/shared/utils/data-dirs.ts
git commit -m "feat(fs): add org-scoped project path helpers"
```

---

### Task 2.2: Update callers of the old `projectsDir()` / `hostProjectsDir()`

**Files (from grep):**
- Modify: [server/shared/utils/specifyr-stores.ts:51,71](server/shared/utils/specifyr-stores.ts#L51)
- Modify: [server/shared/utils/project-creation.ts:35](server/shared/utils/project-creation.ts#L35)
- Modify: [server/projects/api/projects/[slug].delete.ts:11-12](server/projects/api/projects/[slug].delete.ts#L11-L12) — will be deleted in Phase 4, but for now adapt it.
- Any other compile errors from Task 2.1 Step 2.

**Step 1: For each call site, replace the old API with the new**

Patterns:
- `projectsDir()` (no args, returns root) → `projectsRoot()`
- `path.join(projectsDir(), slug)` → `projectDir(orgId, slug)` — caller now needs `orgId`. If the caller is a pre-middleware path helper that doesn't have orgId, change its signature to require it.
- `path.join(dataDir(), ".specifyr", slug)` → `projectArtifactsDir(orgId, slug)`.

In `specifyr-stores.ts`, change `projectCwd(slug: string)` → `projectCwd(orgId: string, slug: string)`, similarly `projectHostCwd` and `assertProjectExists`.

**Step 2: Update transitive callers**

```bash
pnpm exec tsc --noEmit 2>&1 | grep -E "projectCwd|projectHostCwd|assertProjectExists" | head -20
```

Each error site needs `orgId`. Where does `orgId` come from? Two cases:
1. **Request handlers** — `event.context.orgId` (will be set by the middleware introduced in Phase 3). For now, look up via `getProjectFromDb(slug).then(p => p.ownerOrgId)` so the code compiles. Add a `TODO(phase-3): remove DB lookup, read from event.context.orgId after middleware lands` comment.
2. **Pure utility functions** — propagate the `orgId` parameter up through the call chain. Don't reach into the DB from a pure util.

**Step 3: Compile clean**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -20
```

Expected: 0 errors related to path helpers. There will still be other errors from later phases — that's fine.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor(fs): thread orgId through path-helper call sites"
```

---

### Task 2.3: Update `ArtifactStore` to be org-aware

**Files:**
- Modify: [src/core/artifact-store.js:1-50](src/core/artifact-store.js#L1-L50)

**Step 1: Change constructor + paths to require orgId**

```js
import path from "node:path";
import { SPECIFYR_DIR } from "./constants.js";
import { ensureDir, exists, readJson, readText, resolveFromCwd, writeJson, writeText } from "../utils/fs.js";

export class ArtifactStore {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.rootDir = resolveFromCwd(cwd, SPECIFYR_DIR);
  }

  getOrgDir(orgId) {
    return path.join(this.rootDir, orgId);
  }

  getProjectDir(orgId, slug) {
    return path.join(this.getOrgDir(orgId), slug);
  }

  getProjectPaths(orgId, slug) {
    const baseDir = this.getProjectDir(orgId, slug);
    return {
      baseDir,
      spec: path.join(baseDir, "spec.md"),
      // ... unchanged
    };
  }

  async createProject(orgId, slug, title, specContent, metaExtras = {}) {
    const paths = this.getProjectPaths(orgId, slug);
    if (await exists(paths.baseDir)) {
      throw new Error(`Project '${slug}' already exists in org.`);
    }
    // ... rest unchanged
  }

  async saveArtifact(orgId, slug, type, value) { /* take orgId, pass through */ }
  async loadArtifact(orgId, slug, type, fallback = null) { /* take orgId, pass through */ }
  async listProjects(orgId) { /* now scoped to one org */ }
}
```

**Step 2: Find and update every ArtifactStore call site**

```bash
grep -rn "new ArtifactStore\|artifactStore\." server src --include="*.ts" --include="*.js" 2>/dev/null
```

For each: thread `orgId` through. Same TODO-comment pattern as Task 2.2 if it's pre-middleware.

**Step 3: Repeat for the other slug-keyed stores**

```bash
grep -rn "class SessionStore\|class StepStateStore\|class EventStore\|class RunStore" src
```

For each store:
- Find every `path.join(...something..., slug, ...)` inside and insert `orgId` before `slug`.
- Update constructor/method signatures.
- Update call sites in `server/shared/utils/specifyr-stores.ts`.

Be exhaustive — missing a single store keeps a slug-globally-unique escape hatch alive.

**Step 4: Compile**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -10
```

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor(fs): make ArtifactStore and stores org-aware"
```

---

## Phase 3 — Project-Store + Access Middleware

### Task 3.1: Update `project-store.ts` for composite key

**Files:**
- Modify: [server/shared/utils/project-store.ts](server/shared/utils/project-store.ts)

**Step 1: Add `getProjectByOrgAndSlug`**

```ts
export async function getProjectByOrgAndSlug(
  orgId: string,
  slug: string,
): Promise<Project | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerOrgId, orgId), eq(projects.slug, slug)))
    .limit(1);
  return row ?? null;
}
```

**Step 2: Mark `getProjectFromDb(slug)` `@deprecated`**

Add JSDoc:
```ts
/** @deprecated Use getProjectByOrgAndSlug. Slugs are not globally unique anymore. */
```

Keep the implementation for now (handlers in Phase 4 still call it during transition). Phase 4 deletes it.

**Step 3: Update `userOwnsProject` to take orgId**

```ts
export async function userOwnsProject(
  orgId: string,
  slug: string,
  userId: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const project = await getProjectByOrgAndSlug(orgId, slug);
  if (!project) return false;
  // ... membership check unchanged
}
```

Update existing call sites — there should be few. Compile.

**Step 4: Test**

Write unit test asserting that:
- Two projects with same slug in different orgs both insert successfully.
- Inserting a duplicate `(orgId, slug)` pair throws a unique-constraint violation.

```ts
// tests/server/project-store.spec.ts
import { describe, it, expect } from "vitest";
import { recordProjectOwnership, getProjectByOrgAndSlug } from "@su/project-store";

describe("project-store org-scoped uniqueness", () => {
  it("allows the same slug in two different orgs", async () => {
    const orgA = await createTestOrg("a");
    const orgB = await createTestOrg("b");
    const a = await recordProjectOwnership("shared-slug", { ownerOrgId: orgA.id });
    const b = await recordProjectOwnership("shared-slug", { ownerOrgId: orgB.id });
    expect(a?.id).not.toBe(b?.id);
    expect((await getProjectByOrgAndSlug(orgA.id, "shared-slug"))?.id).toBe(a?.id);
  });

  it("rejects duplicate (orgId, slug)", async () => {
    const org = await createTestOrg("dup");
    await recordProjectOwnership("twice", { ownerOrgId: org.id });
    await expect(
      recordProjectOwnership("twice", { ownerOrgId: org.id }),
    ).rejects.toThrow(/duplicate|unique/i);
  });
});
```

Add `createTestOrg` helper if missing (look at existing tests under `tests/server/` for patterns).

Run:
```bash
pnpm test:e2e -- tests/server/project-store.spec.ts
```

Expected: both tests pass.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): add org-scoped project lookup + tests"
```

---

### Task 3.2: Project-access middleware

**Files:**
- Create: `server/shared/middleware/project-access.ts`
- Modify: `server/shared/middleware/auth.ts` (add typed `event.context` fields)

**Step 1: Extend H3 context types**

In [server/shared/middleware/auth.ts:10-16](server/shared/middleware/auth.ts#L10-L16), extend the module augmentation:

```ts
declare module "h3" {
  interface H3EventContext {
    userId?: string;
    userEmail?: string;
    /** Set by project-access middleware on /api/orgs/:orgSlug/projects/:projSlug/* routes. */
    orgId?: string;
    orgSlug?: string;
    projectSlug?: string;
  }
}
```

**Step 2: Write the middleware**

`server/shared/middleware/project-access.ts`:

```ts
import { getOrgBySlug, getMembership } from "@su/org-store";
import { getProjectByOrgAndSlug } from "@su/project-store";

/**
 * Resolves /api/orgs/:orgSlug/projects/:projSlug/* URLs:
 *   - 401 if unauthenticated
 *   - 404 if org or project doesn't exist
 *   - 403 if user is not a member of the org
 *   - On success: attaches { orgId, orgSlug, projectSlug } to event.context
 *
 * Skip-list: paths that don't fit the (orgSlug, projSlug) pattern bypass.
 */
const PROJECT_PATH_RE =
  /^\/api\/orgs\/([^/]+)\/projects\/([^/]+)(\/|$)/;

export default defineEventHandler(async (event) => {
  const path = event.path ?? event.node.req.url ?? "";
  const match = PROJECT_PATH_RE.exec(path);
  if (!match) return;

  const [, orgSlug, projSlug] = match;

  const userId = event.context.userId;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "not authenticated" });
  }

  const org = await getOrgBySlug(orgSlug);
  if (!org) {
    throw createError({ statusCode: 404, statusMessage: "org not found" });
  }
  const membership = await getMembership(org.id, userId);
  if (!membership) {
    throw createError({ statusCode: 403, statusMessage: "not a member of this org" });
  }
  const project = await getProjectByOrgAndSlug(org.id, projSlug);
  if (!project) {
    throw createError({ statusCode: 404, statusMessage: "project not found" });
  }

  event.context.orgId = org.id;
  event.context.orgSlug = orgSlug;
  event.context.projectSlug = projSlug;
});
```

**Step 3: Verify middleware load order**

Nuxt loads middleware alphabetically. `auth.ts` < `project-access.ts` alphabetically, so auth runs first. Verify:

```bash
ls server/shared/middleware/
```

If ordering is broken, prefix with a number (`01-auth.ts`, `02-project-access.ts`).

**Step 4: Tests**

`tests/server/project-access.spec.ts`:

```ts
describe("project-access middleware", () => {
  it("401s unauthenticated requests", async () => { /* curl /api/orgs/x/projects/y, no auth */ });
  it("404s unknown org", async () => { /* authed, bad orgSlug */ });
  it("403s non-member", async () => { /* authed, member-of-other-org */ });
  it("404s unknown project under valid org", async () => { /* authed member, bad projSlug */ });
  it("succeeds with valid (orgSlug, projSlug, membership)", async () => {
    // assert event.context.orgId is populated downstream
  });
  it("skips non-project URLs", async () => { /* /api/orgs/x/foo */ });
});
```

Use existing e2e helpers if present (look in `tests/e2e/` or `tests/server/`).

Run:
```bash
pnpm test:e2e -- tests/server/project-access.spec.ts
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): project-access middleware for org-scoped routes"
```

---

## Phase 4 — API Route Restructuring

### Task 4.1: Move all `/api/projects/[slug]/*` to `/api/orgs/[orgSlug]/projects/[projSlug]/*`

**Files:** all 36 routes under [server/projects/api/projects/](server/projects/api/projects/).

**Step 1: Reorganize folder structure**

```bash
mkdir -p server/projects/api/orgs/\[orgSlug\]/projects
git mv server/projects/api/projects/\[slug\] server/projects/api/orgs/\[orgSlug\]/projects/\[projSlug\]
git mv server/projects/api/projects/\[slug\].get.ts server/projects/api/orgs/\[orgSlug\]/projects/\[projSlug\].get.ts
git mv server/projects/api/projects/\[slug\].delete.ts server/projects/api/orgs/\[orgSlug\]/projects/\[projSlug\].delete.ts
```

Don't move the list/create routes yet (Task 4.2).

**Step 2: Update each route handler**

For every handler in the moved directory, replace:
- `getRouterParam(event, "slug")` → `event.context.projectSlug` (set by middleware; guaranteed non-null because middleware would have errored otherwise)
- `getProjectFromDb(slug)` calls → use `event.context.orgId` directly. Where the full Project row is still needed, call `getProjectByOrgAndSlug(orgId, slug)`.
- `userOwnsProject(slug, userId)` calls → delete the call entirely. Middleware has already gated access.
- Any `path.join(...slug...)` for FS → use new `projectDir(orgId, projSlug)` / `projectArtifactsDir(orgId, projSlug)` helpers.

Open each file, do the swap, save. There are 36 files — go file by file, commit in groups of ~10.

After each group, compile-check:
```bash
pnpm exec tsc --noEmit 2>&1 | tail -10
```

**Step 3: Delete `getProjectFromDb` once unused**

```bash
grep -rn "getProjectFromDb" server/ --include="*.ts" | grep -v deprecated
```

Should be empty (besides the export itself). Delete the function.

**Step 4: Commit per group**

```bash
git add server/projects/api/orgs/
git commit -m "refactor(api): move project routes under /api/orgs/[orgSlug]/projects/[projSlug]"
```

---

### Task 4.2: Update list + create endpoints

**Files:**
- Move: [server/projects/api/projects.post.ts](server/projects/api/projects.post.ts) → `server/projects/api/orgs/[orgSlug]/projects.post.ts`
- Modify: [server/projects/api/projects.get.ts](server/projects/api/projects.get.ts) — keep at `/api/projects` (list across user's orgs), but also add per-org variant

**Step 1: Per-org create**

Move POST handler. Resolve `orgSlug` from `getRouterParam(event, "orgSlug")` — the URL is the source of truth, no more `ownerOrgSlug` in body. Remove the `ownerOrgSlug` field from `createProjectSchema`. Remove the "if user has 1 org, default to it" fallback — the URL is unambiguous.

**Step 2: Keep `/api/projects` (list across orgs)**

Used by the global ProjectListSidebar. Now also returns each project's `orgSlug` so the UI can build correct links:

```ts
// projects.get.ts
const rows = await db
  .select({ slug: projects.slug, orgSlug: orgs.slug, orgId: orgs.id, /* ... */ })
  .from(projects)
  .innerJoin(orgs, eq(orgs.id, projects.ownerOrgId))
  .where(inArray(orgs.id, userOrgIds));
```

Update the orchestrator's `listProjects` similarly — it currently reads FS, now it needs to traverse `~/.specifyr/projects/<orgId>/<projSlug>/`. Return entries with `{ orgId, slug, ... }`. The API handler merges DB+FS info and produces the final UI payload.

**Step 3: Add per-org list `/api/orgs/[orgSlug]/projects.get.ts`**

Returns only projects for that single org. Used by org-scoped views.

**Step 4: Test the routes**

```ts
// tests/e2e/orgs.spec.ts (extend or create)
it("POST /api/orgs/:orgSlug/projects creates a project in that org", async () => { ... });
it("two orgs can both have a project named 'demo'", async () => { ... });
it("POST /api/orgs/:orgSlug/projects 403s for non-members", async () => { ... });
```

Run:
```bash
pnpm test:e2e -- tests/e2e/orgs.spec.ts
```

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor(api): org-scoped project list + create endpoints"
```

---

### Task 4.3: Update `createProjectRecord` for new FS layout + orphan handling

**Files:**
- Modify: [server/shared/utils/project-creation.ts](server/shared/utils/project-creation.ts)

**Step 1: Add orgId to signature, switch paths**

```ts
export async function createProjectRecord(options: {
  ownerOrgId: string; // now required, not nullable
  title: string;
  description: string;
  extensions?: string[];
  workflow?: string;
}) {
  // ...
  const slug = slugify(title);
  const projectRoot = projectDir(options.ownerOrgId, slug);
  const projectsParent = orgProjectsDir(options.ownerOrgId);
  await ensureDir(projectsParent);
  // specify init runs inside projectsParent, creating the slug subdir.
  // ...
}
```

**Step 2: Orphan detection**

Before the `store.createProject` call, add:

```ts
// Orphan check: if FS has leftovers from a previous failed create
// (DB row never written or rolled back), the artifact-store would
// throw "already exists". Detect that case by querying the DB: if no
// row owns this (orgId, slug), the FS is stale — wipe and retry.
const existingRow = await getProjectByOrgAndSlug(options.ownerOrgId, slug);
if (!existingRow) {
  const artifactDir = projectArtifactsDir(options.ownerOrgId, slug);
  if (await exists(artifactDir)) {
    console.warn(`[project-creation] removing orphan artifact dir: ${artifactDir}`);
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
  if (await exists(projectRoot)) {
    console.warn(`[project-creation] removing orphan project dir: ${projectRoot}`);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}
```

Cost is 1 extra DB hit per create; acceptable.

**Step 3: Update the `recordProjectOwnership` call order**

Currently DB-insert happens AFTER FS work. Flip it: insert ownership first (so a partial failure on FS leaves no orphan), then do FS work, then on FS failure roll back the DB row. Pseudocode:

```ts
const row = await recordProjectOwnership(slug, { ownerOrgId: options.ownerOrgId });
try {
  // ... all the FS work
  return record;
} catch (err) {
  // FS failed — undo the DB row so retry doesn't see a phantom-owned slug.
  await deleteProjectFromDb(slug, options.ownerOrgId);
  throw err;
}
```

Add `deleteProjectFromDb(slug, orgId)` to `project-store.ts` if not already there.

**Step 4: Tests**

```ts
it("creates project under projects/<orgId>/<slug>/", async () => { ... });
it("cleans up orphan FS when no DB row exists", async () => {
  // pre-create FS dirs without DB row, then call createProjectRecord,
  // expect success and final state to contain both DB row and FS.
});
it("rolls back DB row if FS work fails", async () => { ... });
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(projects): org-scoped FS layout + orphan recovery"
```

---

## Phase 5 — UI

### Task 5.1: Move UI route directory

**Files:** all under [app/pages/specs/[slug]/](app/pages/specs/[slug]/)

**Step 1: Reorganize**

```bash
mkdir -p app/pages/specs/\[orgSlug\]
git mv app/pages/specs/\[slug\] app/pages/specs/\[orgSlug\]/\[projSlug\]
```

**Step 2: Update `route.params` references**

In each page (`index.vue`, `run.vue`, `runtime.vue`, `secrets.vue`, `history.vue`, `steps/[stepId].vue`):

```ts
// before
const slug = computed(() => route.params.slug as string);

// after
const orgSlug = computed(() => route.params.orgSlug as string);
const projSlug = computed(() => route.params.projSlug as string);
```

**Step 3: Update every `useFetch` URL in those pages**

```ts
// before
useFetch(() => `/api/projects/${slug.value}`);

// after
useFetch(() => `/api/orgs/${orgSlug.value}/projects/${projSlug.value}`);
```

There are dozens of these — work file by file. After each file, save and check:

```bash
pnpm exec tsc --noEmit 2>&1 | grep -E "pages/specs"
```

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor(ui): move spec pages under /specs/[orgSlug]/[projSlug]"
```

---

### Task 5.2: Update components that build project URLs

**Files (from earlier grep):**
- [app/components/layout/ProjectListSidebar.vue](app/components/layout/ProjectListSidebar.vue) — main offender, lists projects + links
- [app/components/projects/ProjectStepSidebar.vue](app/components/projects/ProjectStepSidebar.vue)
- [app/components/projects/ProjectShell.vue](app/components/projects/ProjectShell.vue) — props change: `slug` → `orgSlug, projSlug`
- [app/components/projects/ProjectViewTabs.vue](app/components/projects/ProjectViewTabs.vue)
- [app/components/settings/InstalledExtensionsWidget.vue](app/components/settings/InstalledExtensionsWidget.vue)
- [app/components/agents/CompanyAgentLlmGrid.vue](app/components/agents/CompanyAgentLlmGrid.vue)
- [app/components/ui/ArtifactViewer.vue](app/components/ui/ArtifactViewer.vue)
- [app/components/ui/ChatStream.vue](app/components/ui/ChatStream.vue)
- [app/pages/extensions/[slug].vue](app/pages/extensions/[slug].vue) — verify it doesn't link to projects

**Step 1: ProjectListSidebar — adopt new project list payload**

The `/api/projects` list now returns each project with `orgSlug`. Update:

```vue
<NuxtLink :to="`/specs/${project.orgSlug}/${project.slug}`">{{ project.title }}</NuxtLink>
```

Consider grouping the list by org with a small header per org. Decide based on visual density — if there are <5 projects total, skip grouping. Make a judgment call.

**Step 2: ProjectShell + everything that takes `slug` prop**

Change prop signature:
```ts
withDefaults(
  defineProps<{
    orgSlug: string;
    projSlug: string;
    projectTitle?: string;
    workflow?: Workflow | null;
    showSteps?: boolean;
  }>(),
  { showSteps: true },
);
```

Every callsite passes both props now. Same treatment for ProjectStepSidebar, ProjectViewTabs.

**Step 3: Hunt for stragglers**

```bash
grep -rEn "\\$\\{slug\\}|/specs/\\$|/api/projects/" app --include="*.vue" --include="*.ts" 2>/dev/null
```

Each hit needs adjusting.

**Step 4: Project-create flow**

Find the create form (`ProjectsProjectCreateDialog.vue` or similar). It currently calls `POST /api/projects` with optional `ownerOrgSlug`. Now:
- POST goes to `/api/orgs/${selectedOrg}/projects`
- If user has multiple orgs, the dialog must offer an org picker (likely already does — verify)
- On success, the dialog gets `{ slug, orgSlug }` in the response — navigate to `/specs/${orgSlug}/${slug}`

**Step 5: Compile + commit**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -10
git add -A
git commit -m "refactor(ui): thread orgSlug through project components"
```

---

## Phase 6 — Cleanup + Verification

### Task 6.1: Wipe demo data

**Files:** none

**Step 1: Stop dev server**

```bash
# In the dev-server terminal: Ctrl+C
```

**Step 2: Wipe FS**

```bash
rm -rf ~/.specifyr/.specifyr
rm -rf ~/.specifyr/projects
```

**Step 3: Truncate DB tables**

```bash
docker exec -i specifyr-postgres-dev psql -U postgres -d specifyr <<'SQL'
TRUNCATE TABLE projects CASCADE;
SQL
```

(Org rows and memberships are preserved — only project rows die.)

**Step 4: Confirm clean state**

```bash
ls ~/.specifyr/ 2>/dev/null
docker exec specifyr-postgres-dev psql -U postgres -d specifyr -c "SELECT count(*) FROM projects;"
```

Expected: no `.specifyr/` or `projects/` directory under `~/.specifyr/`, count = 0.

---

### Task 6.2: Manual smoke test

**Files:** none

**Step 1: Start dev server**

```bash
pnpm dev
```

**Step 2: Walk through the flow in the browser**

Test plan (uncheck each box after verifying):

- [ ] Log in. Sidebar shows your org(s) but no projects.
- [ ] Create project "demo" under org A → URL becomes `/specs/<orgA-slug>/demo`.
- [ ] Create project "demo" under org B → succeeds (same slug, different org).
- [ ] Sidebar lists both, links go to the correct org-scoped URL.
- [ ] Click between the two — no cross-pollution of artifacts.
- [ ] On disk: `ls ~/.specifyr/projects/` shows two orgId directories, each with `demo/`.
- [ ] Step page loads, sessions work, artifacts render.
- [ ] Run page loads, tasks list works.
- [ ] Secrets page loads, secrets can be added.
- [ ] Delete project "demo" in org A → it's gone from sidebar + disk; org B's "demo" survives.
- [ ] Create "demo" again in org A → succeeds.
- [ ] Force an orphan: stop server, `mkdir -p ~/.specifyr/projects/<orgA-id>/zombie`, start server, try to create "zombie" in org A → succeeds (orphan got cleaned, log shows the warn).
- [ ] Try to access org B's project URL while logged into org A → 403.

**Step 3: Browser console clean?**

Open DevTools. No `intlify` warnings, no 404s, no unhandled promise rejections.

**Step 4: Commit any small fixes that emerged**

```bash
git add -A
git commit -m "fix(ui): leftover polish after org-scoped manual test"
```

(Skip if nothing to commit.)

---

### Task 6.3: Run full test suite

**Step 1: Unit + integration**

```bash
pnpm test
```

**Step 2: E2E**

```bash
pnpm test:e2e
```

Investigate every failure. Common culprits:
- Old slug-only fixtures that pre-date the refactor.
- Test helpers (`createTestProject`) that didn't get the orgId param.

Don't paper over failing tests — fix the test or fix the code, but don't disable.

**Step 3: Commit fixes**

```bash
git add -A
git commit -m "test: align fixtures with org-scoped project layout"
```

---

### Task 6.4: PR

**Step 1: Push**

```bash
git push -u origin feat/org-scoped-projects
```

**Step 2: Open PR**

```bash
gh pr create --title "feat: org-scoped projects (composite slug, /specs/[orgSlug]/[projSlug])" --body "$(cat <<'EOF'
## Summary
- DB: projects.slug is now unique per org, not platform-wide (composite `(owner_org_id, slug)`).
- FS: project files live at `~/.specifyr/projects/<orgId>/<projSlug>/` and `~/.specifyr/.specifyr/<orgId>/<projSlug>/` — enables per-org volumes / sharding.
- API: routes moved from `/api/projects/[slug]/*` to `/api/orgs/[orgSlug]/projects/[projSlug]/*`. New `project-access` middleware resolves the URL, gates by membership, populates `event.context.orgId`.
- UI: `/specs/[orgSlug]/[projSlug]/*` routes; sidebar groups by org.
- Bonus: orphan detection in createProjectRecord — stale FS without a matching DB row gets wiped before retry, killing the "Project already exists" class of bug.
- No data migration: demo-only environments, dev wipe is part of the rollout.

## Test plan
See Task 6.2 in `docs/plans/2026-05-14-org-scoped-projects.md`.

EOF
)"
```

**Step 3: Confirm PR is green**

CI on PR should pass. If not, read the failure and fix.

---

## Risk + Rollback Notes

- **Single biggest risk:** missing a `slug` reference somewhere — usually safe because TypeScript will catch path-helper signature changes, but raw fetch URLs in `.vue` files are unchecked. The grep step at Task 5.2 Step 3 is the safety net.
- **DB rollback:** the generated migration is reversible if you keep the prior `_journal.json` — but we have no production data and demo gets wiped, so rollback = `git revert` + `drizzle-kit migrate`.
- **No feature flag:** new layout is incompatible with the old one. Don't try to dual-write.

## Skills to reference during execution

- @superpowers:executing-plans — the parent skill driving this plan
- @superpowers:test-driven-development — for the unit/integration tests in Phases 3 + 4
- @superpowers:verification-before-completion — Phase 6 IS this skill, don't skip it
- @superpowers:systematic-debugging — when the manual smoke test surfaces issues
