/**
 * Repository config API E2E tests.
 *
 * Boots a real Nuxt server and exercises the CRUD + push/pull/test
 * endpoints. Skips entirely when DATABASE_URL is unset (the project
 * creation path needs the org/project tables).
 *
 * Token is verified NEVER to be returned by GET — only `hasToken`.
 */

import { describe, beforeAll, beforeEach, expect, it } from "vitest";
import { setup, $fetch } from "@nuxt/test-utils/e2e";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  describe.skip("repository API e2e (DATABASE_URL unset)", () => {
    it("skipped", () => {});
  });
} else {
  process.env.SPECIFYR_SECRET_KEY ||= crypto.randomBytes(32).toString("hex");
  process.env.SPECIFYR_ALLOW_FILE_REMOTES = "1";
  delete process.env.SPECIFYR_DEV_USER_EMAIL;

  describe("repository API e2e", async () => {
    await setup({
      rootDir: fileURLToPath(new URL("../../", import.meta.url)),
      server: true,
      browser: false,
      build: true,
    });

    type AuthHeaders = {
      "x-authentik-email": string;
      "x-authentik-name": string;
    };
    function authAs(email: string, name = "Test User"): AuthHeaders {
      return { "x-authentik-email": email, "x-authentik-name": name };
    }

    beforeEach(async () => {
      const { cleanDb } = await import("../helpers/db.ts");
      await cleanDb();
    });

    async function bootstrapProject(headers: AuthHeaders): Promise<string> {
      await $fetch("/api/me", { headers });
      await $fetch("/api/orgs", {
        method: "POST",
        headers,
        body: { name: "Repo Test Org" },
      });
      const created = await $fetch<{ slug: string }>("/api/projects", {
        method: "POST",
        headers,
        body: {
          title: `repo-test-${Date.now()}`,
          description: "",
        },
      });
      return created.slug;
    }

    it("GET returns configured:false before any PUT", async () => {
      const headers = authAs("alice@example.com");
      const slug = await bootstrapProject(headers);
      const r = await $fetch<{ configured: boolean }>(
        `/api/projects/${slug}/repository`,
        { headers },
      );
      expect(r.configured).toBe(false);
    });

    it("PUT persists repository config + token; GET returns hasToken:true without leaking the token", async () => {
      const headers = authAs("alice@example.com");
      const slug = await bootstrapProject(headers);
      await $fetch(`/api/projects/${slug}/repository`, {
        method: "PUT",
        headers,
        body: {
          url: "https://github.com/acme/demo.git",
          branch: "main",
          username: "acme-bot",
          token: "ghp_supersecret",
        },
      });
      const r = await $fetch<{
        configured: boolean;
        url: string;
        branch: string;
        username: string;
        hasToken: boolean;
        token?: string;
      }>(`/api/projects/${slug}/repository`, { headers });
      expect(r.configured).toBe(true);
      expect(r.url).toBe("https://github.com/acme/demo.git");
      expect(r.branch).toBe("main");
      expect(r.username).toBe("acme-bot");
      expect(r.hasToken).toBe(true);
      expect(r.token).toBeUndefined();
    });

    it("PUT rejects ssh-style URL with 400", async () => {
      const headers = authAs("alice@example.com");
      const slug = await bootstrapProject(headers);
      await expect(
        $fetch(`/api/projects/${slug}/repository`, {
          method: "PUT",
          headers,
          body: {
            url: "git@github.com:acme/demo.git",
            branch: "main",
            username: "x",
            token: "t",
          },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("DELETE removes repository config and token", async () => {
      const headers = authAs("alice@example.com");
      const slug = await bootstrapProject(headers);
      await $fetch(`/api/projects/${slug}/repository`, {
        method: "PUT",
        headers,
        body: {
          url: "https://github.com/acme/demo.git",
          branch: "main",
          username: "u",
          token: "t",
        },
      });
      await $fetch(`/api/projects/${slug}/repository`, {
        method: "DELETE",
        headers,
      });
      const r = await $fetch<{ configured: boolean }>(
        `/api/projects/${slug}/repository`,
        { headers },
      );
      expect(r.configured).toBe(false);
    });

    it("POST /secrets cannot overwrite the reserved git token key", async () => {
      const headers = authAs("alice@example.com");
      const slug = await bootstrapProject(headers);
      await expect(
        $fetch(`/api/projects/${slug}/secrets`, {
          method: "POST",
          headers,
          body: { key: "__git_remote_token", value: "anything" },
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    describe("push endpoint", () => {
      async function setupUpstream(tmpDir: string): Promise<string> {
        const upstream = path.join(tmpDir, "upstream.git");
        await fs.mkdir(upstream);
        await new Promise<void>((resolve, reject) => {
          const p = spawn("git", ["init", "--bare", "-b", "main"], {
            cwd: upstream,
          });
          p.on("exit", (c) =>
            c === 0 ? resolve() : reject(new Error("init bare failed")),
          );
        });
        return `file://${upstream}`;
      }

      it("400 when repository not configured", async () => {
        const headers = authAs("alice@example.com");
        const slug = await bootstrapProject(headers);
        await expect(
          $fetch(`/api/projects/${slug}/repository/push`, {
            method: "POST",
            headers,
            body: { message: "boom" },
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });
    });
  });
}
