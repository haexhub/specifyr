/**
 * org-auth helpers translate the org-membership permission model into
 * h3 errors. Tests use a minimal mock event — the helpers read
 * `event.context.userId` and `getRouterParam(event, "slug")`.
 *
 * `getRouterParam` is a Nuxt auto-import that resolves to h3's
 * `getRouterParam` at runtime. In a node:test context we don't have
 * Nuxt loaded, so we install a global stub before importing the
 * module. createError is similarly auto-imported; we stub it to a
 * plain Error so we can assert on statusCode.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";

interface StubError extends Error {
  statusCode: number;
  statusMessage: string;
}

before(() => {
  const g = globalThis as Record<string, unknown>;
  g.getRouterParam = (event: { _params?: Record<string, string> }, name: string) =>
    event?._params?.[name];
  g.createError = (input: { statusCode: number; statusMessage: string }) => {
    const err = new Error(input.statusMessage) as StubError;
    err.statusCode = input.statusCode;
    err.statusMessage = input.statusMessage;
    return err;
  };
});

after(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.getRouterParam;
  delete g.createError;
});

function makeEvent(opts: {
  userId?: string;
  slug?: string;
}): unknown {
  return {
    context: { userId: opts.userId },
    _params: opts.slug ? { slug: opts.slug } : {},
  };
}

test(
  "requireOrgMembership: 401 when no userId",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { requireOrgMembership } = await import(
        "../../server/shared/utils/org-auth.ts"
      );
      await assert.rejects(
        requireOrgMembership(makeEvent({ slug: "anything" })),
        (err: StubError) => err.statusCode === 401,
      );
    });
  },
);

test(
  "requireOrgMembership: 400 when slug is missing",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { requireOrgMembership } = await import(
        "../../server/shared/utils/org-auth.ts"
      );
      const u = await seedUser();
      await assert.rejects(
        requireOrgMembership(makeEvent({ userId: u.id })),
        (err: StubError) => err.statusCode === 400,
      );
    });
  },
);

test(
  "requireOrgMembership: 404 when slug doesn't resolve to an org",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { requireOrgMembership } = await import(
        "../../server/shared/utils/org-auth.ts"
      );
      const u = await seedUser();
      await assert.rejects(
        requireOrgMembership(
          makeEvent({ userId: u.id, slug: "non-existent-org" }),
        ),
        (err: StubError) => err.statusCode === 404,
      );
    });
  },
);

test(
  "requireOrgMembership: 403 when user is not a member",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { requireOrgMembership } = await import(
        "../../server/shared/utils/org-auth.ts"
      );
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const admin = await seedUser("admin");
      const stranger = await seedUser("stranger");
      const org = await createOrgWithAdmin("Acme", admin.id);
      await assert.rejects(
        requireOrgMembership(
          makeEvent({ userId: stranger.id, slug: org.slug }),
        ),
        (err: StubError) => err.statusCode === 403,
      );
    });
  },
);

test(
  "requireOrgMembership: returns ctx for a valid member",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { requireOrgMembership } = await import(
        "../../server/shared/utils/org-auth.ts"
      );
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      const ctx = await requireOrgMembership(
        makeEvent({ userId: u.id, slug: org.slug }),
      );
      assert.equal(ctx.userId, u.id);
      assert.equal(ctx.org.id, org.id);
      assert.equal(ctx.membership.role, "admin");
    });
  },
);

test(
  "requireOrgAdmin: 403 when user is a member but not admin",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { requireOrgAdmin } = await import(
        "../../server/shared/utils/org-auth.ts"
      );
      const {
        createOrgWithAdmin,
        createInvite,
        acceptInvite,
      } = await import("../../server/shared/utils/org-store.ts");
      const admin = await seedUser("admin");
      const member = await seedUser("member");
      const org = await createOrgWithAdmin("Acme", admin.id);
      const invite = await createInvite({
        orgId: org.id,
        invitedEmail: member.email,
        invitedRole: "member",
        createdBy: admin.id,
      });
      await acceptInvite(invite.token, member.id);
      await assert.rejects(
        requireOrgAdmin(makeEvent({ userId: member.id, slug: org.slug })),
        (err: StubError) =>
          err.statusCode === 403 && /admin/.test(err.statusMessage),
      );
    });
  },
);
