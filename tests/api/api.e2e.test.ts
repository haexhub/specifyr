/**
 * API E2E tests.
 *
 * One Nuxt server is booted per file (singleFork in vitest.config.ts).
 * The auth middleware accepts either `x-authentik-email` headers OR
 * `SPECIFYR_DEV_USER_EMAIL` env — we use the headers so each test can
 * impersonate a different user without restarting the server.
 *
 * DB is cleaned before every test. The test file is skipped entirely
 * when DATABASE_URL is unset.
 */

import { describe, beforeAll, beforeEach, expect, it } from "vitest";
import { setup, $fetch } from "@nuxt/test-utils/e2e";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  // vitest doesn't have a clean "skip whole file" — describe.skipIf
  // bails the suite with a visible reason.
  describe.skip("API e2e (DATABASE_URL unset)", () => {
    it("skipped", () => {});
  });
} else {
  // Generate a stable per-run secret if the user didn't provide one;
  // tests just need any valid 32-byte hex.
  process.env.SPECIFYR_SECRET_KEY ||= crypto.randomBytes(32).toString("hex");
  // The auth middleware falls back to SPECIFYR_DEV_USER_EMAIL when no
  // forward-auth headers are present. That fallback is great for
  // running `pnpm dev` without Authentik, but it would interfere with
  // tests that want to hit a 401 on missing-auth or impersonate a
  // specific user via headers. Strip it for the test process.
  delete process.env.SPECIFYR_DEV_USER_EMAIL;

  // OAuth tests swap CLAUDE_BIN to a deterministic shell stub so the
  // real claude CLI is never invoked. Das ephemerale HOME landet im
  // neuen Modell unter os.tmpdir()/specifyr-oauth/<credentialId> und
  // wird vom Store selbst angelegt + nach Persist gelöscht — kein
  // CREDENTIALS_DIR-Override mehr nötig. CLAUDE_BIN muss vor setup()
  // gesetzt sein, deshalb hier am Module-Load.
  const oauthTmpRoot = path.join(os.tmpdir(), "specifyr-oauth");
  process.env.CLAUDE_BIN = fileURLToPath(
    new URL("./fixtures/fake-claude.sh", import.meta.url),
  );

  describe("API e2e", async () => {
    await setup({
      rootDir: fileURLToPath(new URL("../../", import.meta.url)),
      // setupTimeout governed by vitest hookTimeout (60s).
      server: true,
      browser: false,
      // Speed: skip building the dev SSR client since we only fetch JSON.
      build: true,
    });

    type AuthHeaders = { "x-authentik-email": string; "x-authentik-name": string };
    function authAs(email: string, name = "Test User"): AuthHeaders {
      return { "x-authentik-email": email, "x-authentik-name": name };
    }

    /**
     * Truncate before each test using the same DB pool as the running
     * server. We import the helper lazily so we don't accidentally
     * pull `getDb()` before setup() finishes wiring env vars.
     */
    beforeEach(async () => {
      const { cleanDb } = await import("../helpers/db.ts");
      await cleanDb();
    });

    describe("/api/me", () => {
      it("401s when no auth headers are sent and dev fallback is suppressed", async () => {
        // The auth middleware falls back to SPECIFYR_DEV_USER_EMAIL
        // (loaded from .env in the spawned Nuxt process). The
        // `specifyr-dev-loggedout=1` cookie suppresses that fallback —
        // it's the same mechanism the Logout button uses in dev mode.
        await expect(
          $fetch("/api/me", {
            headers: { cookie: "specifyr-dev-loggedout=1" },
          }),
        ).rejects.toMatchObject({ statusCode: 401 });
      });

      it("returns the authenticated user when headers are present", async () => {
        const me = await $fetch<{ email: string }>("/api/me", {
          headers: authAs("user-a@example.com", "User A"),
        });
        expect(me.email).toBe("user-a@example.com");
      });
    });

    describe("/api/me/llm-credentials", () => {
      const aliceHeaders = authAs("alice@example.com", "Alice");
      const bobHeaders = authAs("bob@example.com", "Bob");

      it("starts empty", async () => {
        const list = await $fetch<unknown[]>("/api/me/llm-credentials", {
          headers: aliceHeaders,
        });
        expect(Array.isArray(list)).toBe(true);
        expect(list).toHaveLength(0);
      });

      it("CRUD: create → list → patch (disable) → delete", async () => {
        const created = await $fetch<{ id: string; enabled: boolean }>(
          "/api/me/llm-credentials",
          {
            method: "POST",
            headers: aliceHeaders,
            body: {
              provider: "anthropic",
              displayName: "Personal",
              apiKey: "sk-ant-test-12345678",
            },
          },
        );
        expect(created.id).toMatch(/[0-9a-f-]{36}/);
        expect(created.enabled).toBe(true);

        let list = await $fetch<{ id: string; enabled: boolean }[]>(
          "/api/me/llm-credentials",
          { headers: aliceHeaders },
        );
        expect(list).toHaveLength(1);

        const patched = await $fetch<{ enabled: boolean }>(
          `/api/me/llm-credentials/${created.id}`,
          {
            method: "PATCH",
            headers: aliceHeaders,
            body: { enabled: false },
          },
        );
        expect(patched.enabled).toBe(false);

        await $fetch(`/api/me/llm-credentials/${created.id}`, {
          method: "DELETE",
          headers: aliceHeaders,
        });
        list = await $fetch("/api/me/llm-credentials", { headers: aliceHeaders });
        expect(list).toHaveLength(0);
      });

      it("rejects invalid provider", async () => {
        await expect(
          $fetch("/api/me/llm-credentials", {
            method: "POST",
            headers: aliceHeaders,
            body: {
              provider: "made-up",
              displayName: "Bad",
              apiKey: "sk-test-1234",
            },
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("rejects too-short api keys", async () => {
        await expect(
          $fetch("/api/me/llm-credentials", {
            method: "POST",
            headers: aliceHeaders,
            body: {
              provider: "anthropic",
              displayName: "Bad",
              apiKey: "short",
            },
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("404s when one user tries to PATCH another user's credential", async () => {
        const aliceCred = await $fetch<{ id: string }>(
          "/api/me/llm-credentials",
          {
            method: "POST",
            headers: aliceHeaders,
            body: {
              provider: "anthropic",
              displayName: "Alice",
              apiKey: "sk-ant-aliceaaaaaa",
            },
          },
        );
        // Bob's lookup is scoped to his ownerId → row doesn't exist
        // for him → 404.
        await expect(
          $fetch(`/api/me/llm-credentials/${aliceCred.id}`, {
            method: "PATCH",
            headers: bobHeaders,
            body: { enabled: false },
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });
    });

    describe("/api/orgs", () => {
      const adminHeaders = authAs("admin@example.com", "Admin");
      const memberHeaders = authAs("member@example.com", "Member");
      const strangerHeaders = authAs("stranger@example.com", "Stranger");

      async function createOrg(name: string) {
        return $fetch<{ id: string; slug: string; name: string }>("/api/orgs", {
          method: "POST",
          headers: adminHeaders,
          body: { name },
        });
      }

      it("creates an org with the caller as admin", async () => {
        const org = await createOrg("Acme Co");
        expect(org.slug).toBe("acme-co");
        const list = await $fetch<{ slug: string; role: string }[]>(
          "/api/orgs",
          { headers: adminHeaders },
        );
        expect(list).toHaveLength(1);
        expect(list[0]?.role).toBe("admin");
      });

      it("invite + accept flow grants membership", async () => {
        const org = await createOrg("Acme");
        // Make sure the recipient user exists by hitting /api/me first.
        await $fetch("/api/me", { headers: memberHeaders });
        const invite = await $fetch<{ acceptPath: string; token: string }>(
          `/api/orgs/${org.slug}/invites`,
          {
            method: "POST",
            headers: adminHeaders,
            body: { email: "member@example.com", role: "member" },
          },
        );
        expect(invite.acceptPath).toMatch(/^\/invites\//);

        const accepted = await $fetch<{ orgSlug: string; role: string }>(
          `/api/invites/${invite.token}/accept`,
          {
            method: "POST",
            headers: memberHeaders,
          },
        );
        expect(accepted.orgSlug).toBe(org.slug);
        expect(accepted.role).toBe("member");

        const memberOrgs = await $fetch<{ slug: string; role: string }[]>(
          "/api/orgs",
          { headers: memberHeaders },
        );
        expect(memberOrgs).toHaveLength(1);
        expect(memberOrgs[0]?.role).toBe("member");
      });

      it("403s when a non-admin tries to invite", async () => {
        const org = await createOrg("Acme");
        // Bring memberHeaders into the org first
        await $fetch("/api/me", { headers: memberHeaders });
        const inv = await $fetch<{ token: string }>(
          `/api/orgs/${org.slug}/invites`,
          {
            method: "POST",
            headers: adminHeaders,
            body: { email: "member@example.com", role: "member" },
          },
        );
        await $fetch(`/api/invites/${inv.token}/accept`, {
          method: "POST",
          headers: memberHeaders,
        });

        await expect(
          $fetch(`/api/orgs/${org.slug}/invites`, {
            method: "POST",
            headers: memberHeaders,
            body: { email: "another@example.com", role: "member" },
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });

      it("403s a stranger from listing members", async () => {
        const org = await createOrg("Acme");
        // Ensure stranger user exists
        await $fetch("/api/me", { headers: strangerHeaders });
        await expect(
          $fetch(`/api/orgs/${org.slug}/members`, {
            headers: strangerHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });
    });

    describe("/api/orgs/:slug/llm-credentials", () => {
      const adminHeaders = authAs("admin@example.com", "Admin");
      const memberHeaders = authAs("member@example.com", "Member");
      const strangerHeaders = authAs("stranger@example.com", "Stranger");

      async function bootstrapOrg() {
        const org = await $fetch<{ slug: string }>("/api/orgs", {
          method: "POST",
          headers: adminHeaders,
          body: { name: "Acme" },
        });
        await $fetch("/api/me", { headers: memberHeaders });
        const inv = await $fetch<{ token: string }>(
          `/api/orgs/${org.slug}/invites`,
          {
            method: "POST",
            headers: adminHeaders,
            body: { email: "member@example.com", role: "member" },
          },
        );
        await $fetch(`/api/invites/${inv.token}/accept`, {
          method: "POST",
          headers: memberHeaders,
        });
        return org;
      }

      it("admin can create, members can list (read-only)", async () => {
        const org = await bootstrapOrg();
        const created = await $fetch<{ id: string }>(
          `/api/orgs/${org.slug}/llm-credentials`,
          {
            method: "POST",
            headers: adminHeaders,
            body: {
              provider: "anthropic",
              displayName: "Org shared",
              apiKey: "sk-ant-org-shared",
            },
          },
        );
        expect(created.id).toMatch(/[0-9a-f-]{36}/);

        const adminView = await $fetch<{
          myRole: string;
          credentials: { id: string }[];
        }>(`/api/orgs/${org.slug}/llm-credentials`, { headers: adminHeaders });
        expect(adminView.myRole).toBe("admin");
        expect(adminView.credentials).toHaveLength(1);

        const memberView = await $fetch<{
          myRole: string;
          credentials: unknown[];
        }>(`/api/orgs/${org.slug}/llm-credentials`, { headers: memberHeaders });
        expect(memberView.myRole).toBe("member");
        expect(memberView.credentials).toHaveLength(1);
      });

      it("members are blocked from POST/PATCH/DELETE", async () => {
        const org = await bootstrapOrg();
        const created = await $fetch<{ id: string }>(
          `/api/orgs/${org.slug}/llm-credentials`,
          {
            method: "POST",
            headers: adminHeaders,
            body: {
              provider: "anthropic",
              displayName: "Org shared",
              apiKey: "sk-ant-org-shared",
            },
          },
        );

        await expect(
          $fetch(`/api/orgs/${org.slug}/llm-credentials`, {
            method: "POST",
            headers: memberHeaders,
            body: {
              provider: "anthropic",
              displayName: "Sneaky",
              apiKey: "sk-ant-sneakytry",
            },
          }),
        ).rejects.toMatchObject({ statusCode: 403 });

        await expect(
          $fetch(`/api/orgs/${org.slug}/llm-credentials/${created.id}`, {
            method: "PATCH",
            headers: memberHeaders,
            body: { enabled: false },
          }),
        ).rejects.toMatchObject({ statusCode: 403 });

        await expect(
          $fetch(`/api/orgs/${org.slug}/llm-credentials/${created.id}`, {
            method: "DELETE",
            headers: memberHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });

      it("strangers get 403 on list", async () => {
        const org = await bootstrapOrg();
        // Make sure stranger user exists in DB
        await $fetch("/api/me", { headers: strangerHeaders });
        await expect(
          $fetch(`/api/orgs/${org.slug}/llm-credentials`, {
            headers: strangerHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });
    });

    describe("project-access middleware", () => {
      const adminHeaders = authAs("admin@example.com", "Admin");
      const memberHeaders = authAs("member@example.com", "Member");
      const strangerHeaders = authAs("stranger@example.com", "Stranger");

      async function bootstrapOrgWithProject(slug = "demo") {
        const org = await $fetch<{ id: string; slug: string }>("/api/orgs", {
          method: "POST",
          headers: adminHeaders,
          body: { name: "Acme " + Date.now() },
        });
        // Insert a project row directly so we can test middleware
        // against the DB without depending on the project-create flow
        // (which Phase 4 reshapes).
        const { recordProjectOwnership } = await import(
          "../../server/shared/utils/project-store.ts"
        );
        await recordProjectOwnership(slug, { ownerOrgId: org.id });
        return { org, slug };
      }

      it("401s unauthenticated requests under /api/orgs/:orgSlug/projects/:projSlug/*", async () => {
        const { org, slug } = await bootstrapOrgWithProject();
        await expect(
          $fetch(`/api/orgs/${org.slug}/projects/${slug}/anything`, {
            headers: { cookie: "specifyr-dev-loggedout=1" },
          }),
        ).rejects.toMatchObject({ statusCode: 401 });
      });

      it("404s when org doesn't exist", async () => {
        // Member exists so we're authenticated but the orgSlug is bogus.
        await $fetch("/api/me", { headers: memberHeaders });
        await expect(
          $fetch("/api/orgs/no-such-org/projects/whatever/anything", {
            headers: memberHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });

      it("403s when user is not a member of the org", async () => {
        const { org, slug } = await bootstrapOrgWithProject();
        await $fetch("/api/me", { headers: strangerHeaders });
        await expect(
          $fetch(`/api/orgs/${org.slug}/projects/${slug}/anything`, {
            headers: strangerHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });

      it("404s when project doesn't exist under a valid org", async () => {
        const { org } = await bootstrapOrgWithProject();
        await expect(
          $fetch(`/api/orgs/${org.slug}/projects/ghost/anything`, {
            headers: adminHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });

      it("skips non-project URLs (regex miss → bypasses checks)", async () => {
        // /api/orgs/<slug>/invites is org-scoped but NOT project-scoped,
        // so the middleware regex doesn't match — the request should
        // reach the orgs/invites handler instead of being gated here.
        const org = await $fetch<{ slug: string }>("/api/orgs", {
          method: "POST",
          headers: adminHeaders,
          body: { name: "BypassTest " + Date.now() },
        });
        // Admin creating an invite in their own org should succeed —
        // proves /api/orgs/.../invites is not gated by project-access.
        const invite = await $fetch<{ token: string }>(
          `/api/orgs/${org.slug}/invites`,
          {
            method: "POST",
            headers: adminHeaders,
            body: { email: "skipped@example.com", role: "member" },
          },
        );
        expect(invite.token).toMatch(/^[0-9a-f]+$/);
      });

      it("passes through when (orgSlug, projSlug, membership) all resolve", async () => {
        // Real project routes are added in Phase 4. Until then, hitting
        // a valid (orgSlug, projSlug) URL with no handler returns 404
        // — but crucially NOT 401/403/404-from-middleware. The middleware
        // pass-through is observable because the error message is
        // h3's generic "Cannot find any route matching" instead of the
        // middleware's "not authenticated" / "not a member" / etc.
        const { org, slug } = await bootstrapOrgWithProject();
        await expect(
          $fetch(`/api/orgs/${org.slug}/projects/${slug}/__nonexistent`, {
            headers: adminHeaders,
          }),
        ).rejects.toMatchObject({
          statusCode: 404,
          // h3 emits "Cannot find any route matching ..." when the
          // middleware passes but no handler matches.
          statusMessage: /cannot find any route/i,
        });
      });
    });

    describe("/api/projects POST with ownerOrgSlug", () => {
      const adminHeaders = authAs("admin@example.com", "Admin");
      const strangerHeaders = authAs("stranger@example.com", "Stranger");

      it("rejects ownerOrgSlug when caller is not a member", async () => {
        const org = await $fetch<{ slug: string }>("/api/orgs", {
          method: "POST",
          headers: adminHeaders,
          body: { name: "Acme" },
        });
        // Make sure stranger user exists
        await $fetch("/api/me", { headers: strangerHeaders });
        // Stranger tries to create a project owned by Acme
        await expect(
          $fetch("/api/projects", {
            method: "POST",
            headers: strangerHeaders,
            body: {
              title: "stolen project " + Date.now(),
              description: "",
              ownerOrgSlug: org.slug,
            },
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });

      it("404s when ownerOrgSlug doesn't resolve", async () => {
        await expect(
          $fetch("/api/projects", {
            method: "POST",
            headers: adminHeaders,
            body: {
              title: "x" + Date.now(),
              description: "",
              ownerOrgSlug: "no-such-org",
            },
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });
    });

    describe("/api/me/llm-credentials/oauth/anthropic", () => {
      const oauthHeaders = authAs("oauth-user@example.com", "OAuth User");
      const otherHeaders = authAs("oauth-other@example.com", "Other");
      const base = "/api/me/llm-credentials/oauth/anthropic";

      // Wipe any leftover .credentials.json between tests so a flow
      // that wrote one in test N doesn't bleed into test N+1's
      // "starts pending" assertion.
      beforeEach(async () => {
        await fs.rm(oauthTmpRoot, { recursive: true, force: true });
      });

      it("start: returns the auth URL parsed from the (fake) CLI stdout", async () => {
        const r = await $fetch<{ id: string; url: string }>(`${base}/start`, {
          method: "POST",
          headers: oauthHeaders,
        });
        expect(r.id).toMatch(/[0-9a-f-]{36}/);
        expect(r.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);

        // Status before the user pastes the code: still pending.
        const status = await $fetch<{ oauthStatus: string }>(
          `${base}/${r.id}/status`,
          { headers: oauthHeaders },
        );
        expect(status.oauthStatus).toBe("pending");

        // Cleanup: cancel the held-open subprocess so it doesn't
        // leak between tests.
        await $fetch(`${base}/${r.id}/cancel`, {
          method: "POST",
          headers: oauthHeaders,
        });
      });

      it("start → code: writes credentials.json and marks the row authorized", async () => {
        const started = await $fetch<{ id: string }>(`${base}/start`, {
          method: "POST",
          headers: oauthHeaders,
        });
        const after = await $fetch<{ oauthStatus: string; expiresAt: string }>(
          `${base}/${started.id}/code`,
          {
            method: "POST",
            headers: oauthHeaders,
            body: { code: "GOOD-CODE" },
          },
        );
        expect(after.oauthStatus).toBe("authorized");
        expect(new Date(after.expiresAt).getTime()).toBeGreaterThan(Date.now());

        // Status now reflects the same authorized state.
        const status = await $fetch<{ oauthStatus: string }>(
          `${base}/${started.id}/status`,
          { headers: oauthHeaders },
        );
        expect(status.oauthStatus).toBe("authorized");
      });

      it("code: rejects when the (fake) CLI exits non-zero", async () => {
        const started = await $fetch<{ id: string }>(`${base}/start`, {
          method: "POST",
          headers: oauthHeaders,
        });
        await expect(
          $fetch(`${base}/${started.id}/code`, {
            method: "POST",
            headers: oauthHeaders,
            body: { code: "BAD" },
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("start: replaces a stale pending row instead of stacking duplicates", async () => {
        const first = await $fetch<{ id: string }>(`${base}/start`, {
          method: "POST",
          headers: oauthHeaders,
        });
        const second = await $fetch<{ id: string }>(`${base}/start`, {
          method: "POST",
          headers: oauthHeaders,
        });
        expect(second.id).not.toBe(first.id);

        const list = await $fetch<{ id: string; mode: string }[]>(
          "/api/me/llm-credentials",
          { headers: oauthHeaders },
        );
        const oauthRows = list.filter((c) => c.mode === "oauth_claude");
        expect(oauthRows).toHaveLength(1);
        expect(oauthRows[0]?.id).toBe(second.id);

        await $fetch(`${base}/${second.id}/cancel`, {
          method: "POST",
          headers: oauthHeaders,
        });
      });

      it("code: 404 when another user submits a code for someone else's flow", async () => {
        const started = await $fetch<{ id: string }>(`${base}/start`, {
          method: "POST",
          headers: oauthHeaders,
        });
        await expect(
          $fetch(`${base}/${started.id}/code`, {
            method: "POST",
            headers: otherHeaders,
            body: { code: "GOOD-CODE" },
          }),
        ).rejects.toMatchObject({ statusCode: 404 });

        await $fetch(`${base}/${started.id}/cancel`, {
          method: "POST",
          headers: oauthHeaders,
        });
      });

      it("cancel: deletes the pending row + 404 on subsequent cancel", async () => {
        const started = await $fetch<{ id: string }>(`${base}/start`, {
          method: "POST",
          headers: oauthHeaders,
        });
        const r = await $fetch<{ ok: boolean }>(
          `${base}/${started.id}/cancel`,
          { method: "POST", headers: oauthHeaders },
        );
        expect(r.ok).toBe(true);

        // Row is gone now → ownership lookup 404s.
        await expect(
          $fetch(`${base}/${started.id}/cancel`, {
            method: "POST",
            headers: oauthHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });
    });

    describe("/api/orgs/:slug/llm-credentials/oauth/anthropic", () => {
      const adminHeaders = authAs("oauth-org-admin@example.com", "Org Admin");
      const memberHeaders = authAs("oauth-org-member@example.com", "Org Member");
      const strangerHeaders = authAs("oauth-org-stranger@example.com", "Stranger");

      // Each test boots a fresh org with admin + member to exercise
      // the permission matrix without cross-test bleed.
      async function bootstrapOrg() {
        const org = await $fetch<{ slug: string; name: string }>("/api/orgs", {
          method: "POST",
          headers: adminHeaders,
          body: { name: "Acme Org" },
        });
        await $fetch("/api/me", { headers: memberHeaders });
        const inv = await $fetch<{ token: string }>(
          `/api/orgs/${org.slug}/invites`,
          {
            method: "POST",
            headers: adminHeaders,
            body: {
              email: "oauth-org-member@example.com",
              role: "member",
            },
          },
        );
        await $fetch(`/api/invites/${inv.token}/accept`, {
          method: "POST",
          headers: memberHeaders,
        });
        return {
          slug: org.slug,
          base: `/api/orgs/${org.slug}/llm-credentials/oauth/anthropic`,
        };
      }

      beforeEach(async () => {
        await fs.rm(oauthTmpRoot, { recursive: true, force: true });
      });

      it("admin starts a flow and member sees pending status (read-only)", async () => {
        const { base } = await bootstrapOrg();
        const r = await $fetch<{ id: string; url: string }>(`${base}/start`, {
          method: "POST",
          headers: adminHeaders,
        });
        expect(r.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);

        const memberView = await $fetch<{ oauthStatus: string }>(
          `${base}/${r.id}/status`,
          { headers: memberHeaders },
        );
        expect(memberView.oauthStatus).toBe("pending");

        await $fetch(`${base}/${r.id}/cancel`, {
          method: "POST",
          headers: adminHeaders,
        });
      });

      it("admin completes the flow → org credential authorized", async () => {
        const { base } = await bootstrapOrg();
        const started = await $fetch<{ id: string }>(`${base}/start`, {
          method: "POST",
          headers: adminHeaders,
        });
        const after = await $fetch<{ oauthStatus: string; expiresAt: string }>(
          `${base}/${started.id}/code`,
          {
            method: "POST",
            headers: adminHeaders,
            body: { code: "GOOD-CODE" },
          },
        );
        expect(after.oauthStatus).toBe("authorized");
      });

      it("members are blocked from start / code / cancel (admin-only)", async () => {
        const { base } = await bootstrapOrg();
        await expect(
          $fetch(`${base}/start`, {
            method: "POST",
            headers: memberHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });

        // Admin starts the flow so we have a real id to test code/cancel against.
        const started = await $fetch<{ id: string }>(`${base}/start`, {
          method: "POST",
          headers: adminHeaders,
        });

        await expect(
          $fetch(`${base}/${started.id}/code`, {
            method: "POST",
            headers: memberHeaders,
            body: { code: "GOOD-CODE" },
          }),
        ).rejects.toMatchObject({ statusCode: 403 });

        await expect(
          $fetch(`${base}/${started.id}/cancel`, {
            method: "POST",
            headers: memberHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });

        // Cleanup with admin auth so the held-open subprocess doesn't
        // leak into the next test.
        await $fetch(`${base}/${started.id}/cancel`, {
          method: "POST",
          headers: adminHeaders,
        });
      });

      it("strangers get 403 even on read-only status", async () => {
        const { base } = await bootstrapOrg();
        const started = await $fetch<{ id: string }>(`${base}/start`, {
          method: "POST",
          headers: adminHeaders,
        });
        await $fetch("/api/me", { headers: strangerHeaders });
        await expect(
          $fetch(`${base}/${started.id}/status`, {
            headers: strangerHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });

        await $fetch(`${base}/${started.id}/cancel`, {
          method: "POST",
          headers: adminHeaders,
        });
      });
    });
  });
}
