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
  "listProjectKeysForUser: admins see all org projects, non-admin members see only projects they're added to",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        recordProjectOwnership,
        listProjectKeysForUser,
        addProjectMember,
      } = await import("../../server/shared/utils/project-store.ts");
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

      const acmeApp = await recordProjectOwnership("acme-app", {
        ownerOrgId: acme.id,
      });
      await recordProjectOwnership("acme-side", { ownerOrgId: acme.id });
      await recordProjectOwnership("beta-app", { ownerOrgId: beta.id });

      const sortKeys = (xs: { orgId: string; slug: string }[]) =>
        xs.map((k) => `${k.orgId}/${k.slug}`).sort();

      // Owner is admin of acme → sees both acme projects
      assert.deepEqual(sortKeys(await listProjectKeysForUser(owner.id)), [
        `${acme.id}/acme-app`,
        `${acme.id}/acme-side`,
      ]);
      // Member of acme but no project memberships → sees nothing
      assert.deepEqual(sortKeys(await listProjectKeysForUser(member.id)), []);
      // Stranger is admin of beta → sees only beta-app
      assert.deepEqual(sortKeys(await listProjectKeysForUser(stranger.id)), [
        `${beta.id}/beta-app`,
      ]);

      // Grant member access to acme-app → now sees it
      await addProjectMember(acmeApp!.id, member.id);
      assert.deepEqual(sortKeys(await listProjectKeysForUser(member.id)), [
        `${acme.id}/acme-app`,
      ]);
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
  "canUserAccessProject: org admins always, org members only with explicit project membership, outsiders never",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        recordProjectOwnership,
        canUserAccessProject,
        addProjectMember,
      } = await import("../../server/shared/utils/project-store.ts");
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
      const project = await recordProjectOwnership("org-project", {
        ownerOrgId: org.id,
      });

      // Admin: implicit access
      assert.equal(
        await canUserAccessProject(org.id, "org-project", admin.id),
        true,
      );
      // Member without explicit project membership: denied
      assert.equal(
        await canUserAccessProject(org.id, "org-project", member.id),
        false,
      );
      // Stranger (not even in org): denied
      assert.equal(
        await canUserAccessProject(org.id, "org-project", stranger.id),
        false,
      );

      // Grant project membership to the member → allowed
      await addProjectMember(project!.id, member.id);
      assert.equal(
        await canUserAccessProject(org.id, "org-project", member.id),
        true,
      );
    });
  },
);

test(
  "canUserAccessProject: returns false for unknown (orgId, slug)",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { canUserAccessProject } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      assert.equal(
        await canUserAccessProject(org.id, "never-existed", u.id),
        false,
      );
    });
  },
);

test(
  "listProjectKeysForUser: returns projects via admin role or project membership",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        recordProjectOwnership,
        listProjectKeysForUser,
        addProjectMember,
      } = await import("../../server/shared/utils/project-store.ts");
      const { createOrgWithAdmin, createInvite, acceptInvite } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const admin = await seedUser("a");
      const member = await seedUser("m");
      const org = await createOrgWithAdmin("Acme", admin.id);
      const invite = await createInvite({
        orgId: org.id,
        invitedEmail: member.email,
        invitedRole: "member",
        createdBy: admin.id,
      });
      await acceptInvite(invite.token, member.id);
      const projA = await recordProjectOwnership("alpha", {
        ownerOrgId: org.id,
      });
      await recordProjectOwnership("beta", { ownerOrgId: org.id });

      // Admin sees both via admin role
      const adminKeys = await listProjectKeysForUser(admin.id);
      const adminSlugs = adminKeys.map((k) => k.slug).sort();
      assert.deepEqual(adminSlugs, ["alpha", "beta"]);

      // Member sees nothing initially
      assert.deepEqual(await listProjectKeysForUser(member.id), []);

      // Grant member explicit access to alpha → sees alpha only
      await addProjectMember(projA!.id, member.id);
      const memberKeys = await listProjectKeysForUser(member.id);
      assert.deepEqual(
        memberKeys.map((k) => k.slug),
        ["alpha"],
      );
    });
  },
);
