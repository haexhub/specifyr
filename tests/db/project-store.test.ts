/**
 * project-store: ownership, listing, access checks. Mandatory-org
 * model — every project belongs to an org; access is gated by
 * membership in `owner_org_id`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";

test(
  "recordProjectOwnership + getProjectFromDb roundtrip (org owner)",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, getProjectFromDb } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      await recordProjectOwnership("my-app", { ownerOrgId: org.id });
      const got = await getProjectFromDb("my-app");
      assert.equal(got?.ownerOrgId, org.id);
    });
  },
);

test(
  "listProjectSlugsForUser: lists projects in user's orgs and nothing else",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, listProjectSlugsForUser } = await import(
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

      const ownerSlugs = (await listProjectSlugsForUser(owner.id)).sort();
      const memberSlugs = (await listProjectSlugsForUser(member.id)).sort();
      const strangerSlugs = (await listProjectSlugsForUser(stranger.id)).sort();

      assert.deepEqual(ownerSlugs, ["acme-app", "acme-side"]);
      assert.deepEqual(memberSlugs, ["acme-app", "acme-side"]);
      assert.deepEqual(strangerSlugs, ["beta-app"]);
    });
  },
);

test(
  "listProjectSlugsForUser: returns empty for users with no orgs",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { listProjectSlugsForUser } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const u = await seedUser("orphan");
      const slugs = await listProjectSlugsForUser(u.id);
      assert.deepEqual(slugs, []);
    });
  },
);

test(
  "userOwnsProject: org members access, outsiders denied",
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

      assert.equal(await userOwnsProject("org-project", admin.id), true);
      assert.equal(await userOwnsProject("org-project", member.id), true);
      assert.equal(await userOwnsProject("org-project", stranger.id), false);
    });
  },
);

test(
  "userOwnsProject: returns false for unknown slug",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { userOwnsProject } = await import(
        "../../server/shared/utils/project-store.ts"
      );
      const u = await seedUser();
      assert.equal(await userOwnsProject("never-existed", u.id), false);
    });
  },
);
