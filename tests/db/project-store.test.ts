/**
 * project-store: ownership, listing, access checks. Mandatory-org
 * model — every project belongs to an org; access is gated by
 * membership in `owner_org_id`. Slugs are unique per-org, not globally.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";

test(
  "recordProjectOwnership + getProjectByOrgAndSlug roundtrip",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, getProjectByOrgAndSlug } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      await recordProjectOwnership("my-app", { ownerOrgId: org.id });
      const got = await getProjectByOrgAndSlug(org.id, "my-app");
      assert.equal(got?.ownerOrgId, org.id);
      assert.equal(got?.slug, "my-app");
    });
  },
);

test(
  "composite uniqueness: same slug in two orgs is allowed",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, getProjectByOrgAndSlug } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const orgA = await createOrgWithAdmin("Acme", u.id);
      const orgB = await createOrgWithAdmin("Beta", u.id);
      const a = await recordProjectOwnership("shared-slug", { ownerOrgId: orgA.id });
      const b = await recordProjectOwnership("shared-slug", { ownerOrgId: orgB.id });
      assert.ok(a && b);
      assert.notEqual(a!.id, b!.id);
      assert.equal(
        (await getProjectByOrgAndSlug(orgA.id, "shared-slug"))?.id,
        a!.id,
      );
      assert.equal(
        (await getProjectByOrgAndSlug(orgB.id, "shared-slug"))?.id,
        b!.id,
      );
    });
  },
);

test(
  "composite uniqueness: rejects duplicate (orgId, slug)",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Dup", u.id);
      await recordProjectOwnership("twice", { ownerOrgId: org.id });
      // Drizzle wraps the pg "duplicate key value violates unique constraint
      // projects_owner_org_slug_uq" error. The unique constraint name is the
      // most reliable token to match against — it survives the wrapper and is
      // unambiguous even if the wrapper text changes.
      await assert.rejects(
        () => recordProjectOwnership("twice", { ownerOrgId: org.id }),
        (err: Error) => {
          const text = `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}`;
          return /projects_owner_org_slug_uq|duplicate key|unique constraint/i.test(text);
        },
      );
    });
  },
);

test(
  "deleteProjectFromDb: removes row, returns true; missing row returns false",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        recordProjectOwnership,
        deleteProjectFromDb,
        getProjectByOrgAndSlug,
      } = await import("../../server/shared/utils/project-store.ts");
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Del", u.id);
      await recordProjectOwnership("temp", { ownerOrgId: org.id });
      assert.equal(await deleteProjectFromDb(org.id, "temp"), true);
      assert.equal(await getProjectByOrgAndSlug(org.id, "temp"), null);
      assert.equal(await deleteProjectFromDb(org.id, "temp"), false);
    });
  },
);

test(
  "listProjectKeysForUser: lists (orgId, slug) pairs for user's orgs only",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, listProjectKeysForUser } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const { createOrgWithAdmin, createInvite, acceptInvite } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const owner = await seedUser("owner");
      const member = await seedUser("member");
      const stranger = await seedUser("stranger");
      const acme = await createOrgWithAdmin("Acme", owner.id);
      const beta = await createOrgWithAdmin("Beta", stranger.id);
      const invite = await createInvite({
        orgId: acme.id,
        invitedEmail: member.email,
        invitedRole: "member",
        createdBy: owner.id,
      });
      await acceptInvite(invite.token, member.id);

      await recordProjectOwnership("acme-app", { ownerOrgId: acme.id });
      await recordProjectOwnership("acme-side", { ownerOrgId: acme.id });
      await recordProjectOwnership("beta-app", { ownerOrgId: beta.id });

      const sortKeys = (xs: { orgId: string; slug: string }[]) =>
        xs.map((k) => `${k.orgId}/${k.slug}`).sort();

      const ownerKeys = sortKeys(await listProjectKeysForUser(owner.id));
      const memberKeys = sortKeys(await listProjectKeysForUser(member.id));
      const strangerKeys = sortKeys(await listProjectKeysForUser(stranger.id));

      assert.deepEqual(ownerKeys, [
        `${acme.id}/acme-app`,
        `${acme.id}/acme-side`,
      ]);
      assert.deepEqual(memberKeys, [
        `${acme.id}/acme-app`,
        `${acme.id}/acme-side`,
      ]);
      assert.deepEqual(strangerKeys, [`${beta.id}/beta-app`]);
    });
  },
);

test(
  "listProjectKeysForUser: returns empty for users with no orgs",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { listProjectKeysForUser } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const u = await seedUser("orphan");
      assert.deepEqual(await listProjectKeysForUser(u.id), []);
    });
  },
);

test(
  "userOwnsProject(orgId, slug, userId): members allowed, outsiders denied",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, userOwnsProject } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const { createOrgWithAdmin, createInvite, acceptInvite } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const admin = await seedUser("admin");
      const member = await seedUser("member");
      const stranger = await seedUser("stranger");
      const org = await createOrgWithAdmin("Acme", admin.id);
      const invite = await createInvite({
        orgId: org.id,
        invitedEmail: member.email,
        invitedRole: "member",
        createdBy: admin.id,
      });
      await acceptInvite(invite.token, member.id);
      await recordProjectOwnership("org-project", { ownerOrgId: org.id });

      assert.equal(await userOwnsProject(org.id, "org-project", admin.id), true);
      assert.equal(await userOwnsProject(org.id, "org-project", member.id), true);
      assert.equal(
        await userOwnsProject(org.id, "org-project", stranger.id),
        false,
      );
    });
  },
);

test(
  "userOwnsProject: returns false for unknown (orgId, slug)",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { userOwnsProject } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      assert.equal(
        await userOwnsProject(org.id, "never-existed", u.id),
        false,
      );
    });
  },
);
