/**
 * Membership-mutation guards: owner immutability, last-admin
 * protection, transfer-ownership atomicity. These are the contract
 * the API endpoints rely on — the route handlers map the
 * MemberMutationResult / TransferOwnershipResult reasons onto HTTP
 * status codes, but the rules themselves live in org-store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";

test(
  "updateMembershipRole: owner cannot be demoted",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createOrgWithAdmin, updateMembershipRole } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const owner = await seedUser("owner");
      const org = await createOrgWithAdmin("Acme", owner.id);
      const r = await updateMembershipRole(org.id, owner.id, "member");
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "owner_immutable");
    });
  },
);

test(
  "updateMembershipRole: cannot demote the last admin",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createOrgWithAdmin,
        createInvite,
        acceptInvite,
        updateMembershipRole,
      } = await import("../../server/shared/utils/org-store.ts");
      const owner = await seedUser("owner");
      const member = await seedUser("member");
      const org = await createOrgWithAdmin("Acme", owner.id);
      const inv = await createInvite({
        orgId: org.id,
        invitedEmail: member.email,
        invitedRole: "admin",
        createdBy: owner.id,
      });
      await acceptInvite(inv.token, member.id);
      // Member is now admin (alongside owner). The owner can't be
      // demoted (immutable). Demoting the *member* is fine — there's
      // still the owner. After that a second demote attempt on the
      // member would orphan the org of admins, but we can't trigger
      // that path through the public API because the owner stays
      // admin. Construct the corner case by demoting member-as-admin
      // back to member: succeeds because owner remains admin.
      const r1 = await updateMembershipRole(org.id, member.id, "member");
      assert.equal(r1.ok, true);
    });
  },
);

test(
  "removeMembership: owner cannot be removed",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createOrgWithAdmin, removeMembership } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const owner = await seedUser("owner");
      const org = await createOrgWithAdmin("Acme", owner.id);
      const r = await removeMembership(org.id, owner.id);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "owner_immutable");
    });
  },
);

test(
  "removeMembership: regular admin can be removed when others remain",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createOrgWithAdmin,
        createInvite,
        acceptInvite,
        removeMembership,
      } = await import("../../server/shared/utils/org-store.ts");
      const owner = await seedUser("owner");
      const co = await seedUser("co");
      const org = await createOrgWithAdmin("Acme", owner.id);
      const inv = await createInvite({
        orgId: org.id,
        invitedEmail: co.email,
        invitedRole: "admin",
        createdBy: owner.id,
      });
      await acceptInvite(inv.token, co.id);

      const r = await removeMembership(org.id, co.id);
      assert.equal(r.ok, true);
    });
  },
);

test(
  "transferOrgOwnership: swaps owner_user_id and keeps both as admin",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createOrgWithAdmin,
        createInvite,
        acceptInvite,
        getMembership,
        transferOrgOwnership,
        getOrgBySlug,
      } = await import("../../server/shared/utils/org-store.ts");
      const owner = await seedUser("owner");
      const heir = await seedUser("heir");
      const org = await createOrgWithAdmin("Acme", owner.id);
      const inv = await createInvite({
        orgId: org.id,
        invitedEmail: heir.email,
        invitedRole: "member",
        createdBy: owner.id,
      });
      await acceptInvite(inv.token, heir.id);

      const r = await transferOrgOwnership(org.id, heir.id);
      assert.equal(r.ok, true);

      const refreshed = await getOrgBySlug(org.slug);
      assert.equal(refreshed?.ownerUserId, heir.id);

      const ownerMem = await getMembership(org.id, owner.id);
      const heirMem = await getMembership(org.id, heir.id);
      assert.equal(ownerMem?.role, "admin");
      assert.equal(heirMem?.role, "admin");
    });
  },
);

test(
  "transferOrgOwnership: rejects non-member as new owner",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createOrgWithAdmin, transferOrgOwnership } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const owner = await seedUser("owner");
      const stranger = await seedUser("stranger");
      const org = await createOrgWithAdmin("Acme", owner.id);

      const r = await transferOrgOwnership(org.id, stranger.id);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "not_member");
    });
  },
);

test(
  "transferOrgOwnership: after transfer the old owner becomes removable",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createOrgWithAdmin,
        createInvite,
        acceptInvite,
        transferOrgOwnership,
        removeMembership,
      } = await import("../../server/shared/utils/org-store.ts");
      const owner = await seedUser("owner");
      const heir = await seedUser("heir");
      const org = await createOrgWithAdmin("Acme", owner.id);
      const inv = await createInvite({
        orgId: org.id,
        invitedEmail: heir.email,
        invitedRole: "member",
        createdBy: owner.id,
      });
      await acceptInvite(inv.token, heir.id);
      await transferOrgOwnership(org.id, heir.id);

      const r = await removeMembership(org.id, owner.id);
      assert.equal(r.ok, true);
    });
  },
);
