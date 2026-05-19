/**
 * E2E tests for the browser-side Speckit agent's REST tool surface
 * (Phase 1 of docs/plans/2026-05-18-browser-mcp-spec-agent.md).
 *
 * Each test bootstraps a fresh project for the impersonated user and
 * writes the required fixture files into the project's working tree
 * directly (the dev API has no "create file" endpoint outside the
 * agent, and the agent is exactly what we're standing in for). Cross-
 * user isolation tests pass each user different `x-authentik-email`
 * headers.
 */

import { describe, beforeEach, expect, it } from "vitest";
import { setup, $fetch } from "@nuxt/test-utils/e2e";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  describe.skip("speckit tools API e2e (DATABASE_URL unset)", () => {
    it("skipped", () => {});
  });
} else {
  process.env.SPECIFYR_SECRET_KEY ||= crypto.randomBytes(32).toString("hex");
  delete process.env.SPECIFYR_DEV_USER_EMAIL;

  describe("speckit tools API e2e", async () => {
    await setup({
      rootDir: fileURLToPath(new URL("../../", import.meta.url)),
      server: true,
      browser: false,
      build: true,
    });

    type AuthHeaders = { "x-authentik-email": string; "x-authentik-name": string };
    const authAs = (email: string, name = "Test User"): AuthHeaders => ({
      "x-authentik-email": email,
      "x-authentik-name": name,
    });

    beforeEach(async () => {
      const { cleanDb } = await import("../helpers/db.ts");
      await cleanDb();
    });

    async function bootstrapProject(
      headers: AuthHeaders,
      titleHint = `speckit-tools-${Date.now()}`,
    ): Promise<{ orgSlug: string; orgId: string; projSlug: string; projectRoot: string }> {
      await $fetch("/api/me", { headers });
      const org = await $fetch<{ slug: string }>("/api/orgs", {
        method: "POST",
        headers,
        body: { name: `Speckit Tools Org ${titleHint}` },
      });
      const created = await $fetch<{ slug: string }>(
        `/api/orgs/${org.slug}/projects`,
        {
          method: "POST",
          headers,
          body: { title: titleHint, description: "" },
        },
      );

      // Need orgId for projectDir(); the project-create response doesn't
      // include it, so look it up via the DB helper.
      const { getOrgBySlug } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const orgRow = await getOrgBySlug(org.slug);
      if (!orgRow) throw new Error(`org ${org.slug} not in DB after create`);

      const { projectDir } = await import(
        "../../server/shared/utils/data-dirs.ts"
      );
      const projectRoot = projectDir(orgRow.id, created.slug);
      return { orgSlug: org.slug, orgId: orgRow.id, projSlug: created.slug, projectRoot };
    }

    async function writeProjectFile(
      projectRoot: string,
      relPath: string,
      content: string,
    ): Promise<void> {
      const abs = path.join(projectRoot, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
    }

    const filesUrl = (orgSlug: string, projSlug: string, query = "") =>
      `/api/orgs/${orgSlug}/projects/${projSlug}/files${query}`;

    describe("GET /api/orgs/:org/projects/:proj/files", () => {
      it("lists files within the project directory", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        await writeProjectFile(projectRoot, "specs/spec.md", "# Spec");
        await writeProjectFile(projectRoot, "README.md", "Hi");

        const res = await $fetch<{ files: Array<{ path: string; type: string }>; truncated: boolean }>(
          filesUrl(orgSlug, projSlug),
          { headers },
        );

        const paths = res.files.map((f) => f.path);
        expect(paths).toContain("README.md");
        expect(paths).toContain("specs/spec.md");
        expect(res.truncated).toBe(false);
      });

      it("honours the glob filter", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        await writeProjectFile(projectRoot, "specs/spec.md", "# Spec");
        await writeProjectFile(projectRoot, "specs/planning.md", "# Plan");
        await writeProjectFile(projectRoot, "README.md", "Hi");

        const res = await $fetch<{ files: Array<{ path: string; type: string }> }>(
          filesUrl(orgSlug, projSlug, "?glob=specs%2F**%2F*.md"),
          { headers },
        );
        const paths = res.files.map((f) => f.path).sort();

        expect(paths).toEqual(["specs/planning.md", "specs/spec.md"]);
      });

      it("excludes .git and node_modules top-level dirs", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        await writeProjectFile(projectRoot, ".git/HEAD", "ref: refs/heads/main");
        await writeProjectFile(projectRoot, "node_modules/foo/index.js", "");
        await writeProjectFile(projectRoot, "src/spec.md", "# Spec");

        const res = await $fetch<{ files: Array<{ path: string }> }>(
          filesUrl(orgSlug, projSlug),
          { headers },
        );
        const paths = res.files.map((f) => f.path);

        expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
        expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
        expect(paths).toContain("src/spec.md");
      });

      it("rejects a glob containing '..'", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);

        await expect(
          $fetch(filesUrl(orgSlug, projSlug, "?glob=..%2F**"), { headers }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("rejects an absolute glob", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);

        await expect(
          $fetch(filesUrl(orgSlug, projSlug, "?glob=%2Fetc%2F**"), { headers }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("403s when the caller is not a member of the project's org", async () => {
        const aliceHeaders = authAs("alice@example.com", "Alice");
        const bobHeaders = authAs("bob@example.com", "Bob");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(
          aliceHeaders,
          `iso-${Date.now()}`,
        );
        await writeProjectFile(projectRoot, "spec.md", "# alice's spec");

        // Bob needs a /me round-trip to be created in the DB.
        await $fetch("/api/me", { headers: bobHeaders });

        await expect(
          $fetch(filesUrl(orgSlug, projSlug), { headers: bobHeaders }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });
    });
  });
}
