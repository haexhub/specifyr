/**
 * project-store: ownership, listing, access checks. Covers the
 * Phase-5 extension where org-owned projects appear in
 * listProjectSlugsForUser and userOwnsProject for any member.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";

test(
  "recordProjectOwnership + getProjectFromDb roundtrip (user owner)",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, getProjectFromDb } = await import(
        "../../server/utils/project-store.ts"
      );
      const u = await seedUser();
      await recordProjectOwnership("my-app", { kind: "user", id: u.id });
      const got = await getProjectFromDb("my-app");
      assert.equal(got?.ownerKind, "user");
      assert.equal(got?.ownerId, u.id);
    });
  },
);

test(
  "listProjectSlugsForUser: includes user-owned and org-owned-via-membership",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, listProjectSlugsForUser } = await import(
        "../../server/utils/project-store.ts"
      );
      const { createOrgWithAdmin, createInvite, acceptInvite } = await import(
        "../../server/utils/org-store.ts"
      );
      const owner = await seedUser("owner");
      const member = await seedUser("member");
      const stranger = await seedUser("stranger");
      const org = await createOrgWithAdmin("Acme", owner.id);
      const invite = await createInvite({
        orgId: org.id,
        invitedEmail: member.email,
        invitedRole: "member",
        createdBy: owner.id,
      });
      await acceptInvite(invite.token, member.id);

      await recordProjectOwnership("personal-of-owner", {
        kind: "user",
        id: owner.id,
      });
      await recordProjectOwnership("org-project", {
        kind: "org",
        id: org.id,
      });
      await recordProjectOwnership("personal-of-stranger", {
        kind: "user",
        id: stranger.id,
      });

      const ownerSlugs = (await listProjectSlugsForUser(owner.id)).sort();
      const memberSlugs = (await listProjectSlugsForUser(member.id)).sort();
      const strangerSlugs = (await listProjectSlugsForUser(stranger.id)).sort();

      assert.deepEqual(ownerSlugs, ["org-project", "personal-of-owner"]);
      assert.deepEqual(memberSlugs, ["org-project"]);
      assert.deepEqual(strangerSlugs, ["personal-of-stranger"]);
    });
  },
);

test(
  "userOwnsProject: user-owner direct match",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, userOwnsProject } = await import(
        "../../server/utils/project-store.ts"
      );
      const a = await seedUser("a");
      const b = await seedUser("b");
      await recordProjectOwnership("a-project", { kind: "user", id: a.id });
      assert.equal(await userOwnsProject("a-project", a.id), true);
      assert.equal(await userOwnsProject("a-project", b.id), false);
    });
  },
);

test(
  "userOwnsProject: org-owner returns true for any member, false for outsiders",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { recordProjectOwnership, userOwnsProject } = await import(
        "../../server/utils/project-store.ts"
      );
      const { createOrgWithAdmin, createInvite, acceptInvite } = await import(
        "../../server/utils/org-store.ts"
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
      await recordProjectOwnership("org-project", {
        kind: "org",
        id: org.id,
      });

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
        "../../server/utils/project-store.ts"
      );
      const u = await seedUser();
      assert.equal(await userOwnsProject("never-existed", u.id), false);
    });
  },
);
