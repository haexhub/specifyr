/**
 * org-store: covers org creation, membership, invite lifecycle.
 * Hits a real Postgres via tests/helpers/db.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";

test(
  "createOrgWithAdmin assigns the creator as admin atomically",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createOrgWithAdmin, getMembership, listMembers } = await import(
        "../../server/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme Co", u.id);
      assert.equal(org.slug, "acme-co");
      assert.equal(org.name, "Acme Co");
      const m = await getMembership(org.id, u.id);
      assert.equal(m?.role, "admin");
      const members = await listMembers(org.id);
      assert.equal(members.length, 1);
      assert.equal(members[0]?.role, "admin");
      assert.equal(members[0]?.email, u.email);
    });
  },
);

test(
  "createOrgWithAdmin: empty/non-sluggable name throws",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createOrgWithAdmin } = await import(
        "../../server/utils/org-store.ts"
      );
      const u = await seedUser();
      await assert.rejects(createOrgWithAdmin("!!!", u.id), /slug/i);
    });
  },
);

test(
  "listOrgsForUser returns orgs the user is a member of, with role",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createOrgWithAdmin, listOrgsForUser } = await import(
        "../../server/utils/org-store.ts"
      );
      const a = await seedUser("a");
      const b = await seedUser("b");
      await createOrgWithAdmin("First", a.id);
      await createOrgWithAdmin("Second", a.id);
      // b is in nothing
      const aOrgs = await listOrgsForUser(a.id);
      const bOrgs = await listOrgsForUser(b.id);
      assert.equal(aOrgs.length, 2);
      assert.ok(aOrgs.every((o) => o.role === "admin"));
      assert.equal(bOrgs.length, 0);
    });
  },
);

test(
  "createInvite + acceptInvite ends with the recipient as a member",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createOrgWithAdmin,
        createInvite,
        acceptInvite,
        getMembership,
      } = await import("../../server/utils/org-store.ts");
      const admin = await seedUser("admin");
      const recipient = await seedUser("recipient");
      const org = await createOrgWithAdmin("Acme", admin.id);

      const invite = await createInvite({
        orgId: org.id,
        invitedEmail: recipient.email,
        invitedRole: "member",
        createdBy: admin.id,
      });
      const result = await acceptInvite(invite.token, recipient.id);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.role, "member");
        assert.equal(result.orgSlug, org.slug);
      }
      const m = await getMembership(org.id, recipient.id);
      assert.equal(m?.role, "member");
    });
  },
);

test(
  "acceptInvite: token used twice → already_used",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createOrgWithAdmin, createInvite, acceptInvite } = await import(
        "../../server/utils/org-store.ts"
      );
      const admin = await seedUser("admin");
      const recipient = await seedUser("recipient");
      const org = await createOrgWithAdmin("Acme", admin.id);
      const invite = await createInvite({
        orgId: org.id,
        invitedEmail: recipient.email,
        invitedRole: "member",
        createdBy: admin.id,
      });
      const first = await acceptInvite(invite.token, recipient.id);
      const second = await acceptInvite(invite.token, recipient.id);
      assert.equal(first.ok, true);
      assert.equal(second.ok, false);
      if (!second.ok) assert.equal(second.reason, "already_used");
    });
  },
);

test(
  "acceptInvite: unknown token → not_found",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { acceptInvite } = await import("../../server/utils/org-store.ts");
      const u = await seedUser();
      const result = await acceptInvite("never-existed", u.id);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, "not_found");
    });
  },
);

test(
  "acceptInvite: revoked token → revoked",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createOrgWithAdmin,
        createInvite,
        acceptInvite,
        revokeInvite,
      } = await import("../../server/utils/org-store.ts");
      const admin = await seedUser("admin");
      const recipient = await seedUser("recipient");
      const org = await createOrgWithAdmin("Acme", admin.id);
      const invite = await createInvite({
        orgId: org.id,
        invitedEmail: recipient.email,
        invitedRole: "member",
        createdBy: admin.id,
      });
      await revokeInvite(invite.token);
      const result = await acceptInvite(invite.token, recipient.id);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, "revoked");
    });
  },
);

test(
  "acceptInvite: expired token → expired",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const { createOrgWithAdmin, createInvite, acceptInvite } = await import(
        "../../server/utils/org-store.ts"
      );
      const { orgInvites } = await import("../../server/db/schema.ts");
      const { eq } = await import("drizzle-orm");
      const admin = await seedUser("admin");
      const recipient = await seedUser("recipient");
      const org = await createOrgWithAdmin("Acme", admin.id);
      const invite = await createInvite({
        orgId: org.id,
        invitedEmail: recipient.email,
        invitedRole: "member",
        createdBy: admin.id,
      });
      // Force-expire the row directly — only way without faking the
      // clock module-wide (createInvite always uses now+TTL).
      await db
        .update(orgInvites)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(orgInvites.token, invite.token));
      const result = await acceptInvite(invite.token, recipient.id);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, "expired");
    });
  },
);

test(
  "listOpenInvites excludes accepted and revoked invites",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createOrgWithAdmin,
        createInvite,
        acceptInvite,
        revokeInvite,
        listOpenInvites,
      } = await import("../../server/utils/org-store.ts");
      const admin = await seedUser("admin");
      const recipient = await seedUser("recipient");
      const org = await createOrgWithAdmin("Acme", admin.id);

      const open = await createInvite({
        orgId: org.id,
        invitedEmail: "open@example.com",
        invitedRole: "member",
        createdBy: admin.id,
      });
      const accepted = await createInvite({
        orgId: org.id,
        invitedEmail: recipient.email,
        invitedRole: "member",
        createdBy: admin.id,
      });
      const revoked = await createInvite({
        orgId: org.id,
        invitedEmail: "revoked@example.com",
        invitedRole: "member",
        createdBy: admin.id,
      });
      await acceptInvite(accepted.token, recipient.id);
      await revokeInvite(revoked.token);

      const list = await listOpenInvites(org.id);
      assert.equal(list.length, 1);
      assert.equal(list[0]?.token, open.token);
    });
  },
);

test(
  "acceptInvite a second time for an already-member upgrades the role",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createOrgWithAdmin,
        createInvite,
        acceptInvite,
        getMembership,
      } = await import("../../server/utils/org-store.ts");
      const admin = await seedUser("admin");
      const recipient = await seedUser("recipient");
      const org = await createOrgWithAdmin("Acme", admin.id);
      // First: member
      const inv1 = await createInvite({
        orgId: org.id,
        invitedEmail: recipient.email,
        invitedRole: "member",
        createdBy: admin.id,
      });
      await acceptInvite(inv1.token, recipient.id);
      // Then admin invites them again as admin
      const inv2 = await createInvite({
        orgId: org.id,
        invitedEmail: recipient.email,
        invitedRole: "admin",
        createdBy: admin.id,
      });
      await acceptInvite(inv2.token, recipient.id);
      const m = await getMembership(org.id, recipient.id);
      assert.equal(m?.role, "admin");
    });
  },
);
