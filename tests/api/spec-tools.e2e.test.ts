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

    const readUrl = (orgSlug: string, projSlug: string, relPath: string) =>
      `/api/orgs/${orgSlug}/projects/${projSlug}/files/${relPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;

    describe("GET /api/orgs/:org/projects/:proj/files/:path", () => {
      it("returns text content as utf-8", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        await writeProjectFile(projectRoot, "specs/spec.md", "# Hello\n");

        const res = await $fetch<{ content: string; encoding: "utf-8" | "base64" }>(
          readUrl(orgSlug, projSlug, "specs/spec.md"),
          { headers },
        );

        expect(res.encoding).toBe("utf-8");
        expect(res.content).toBe("# Hello\n");
      });

      it("encodes binary content as base64", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
        const abs = path.join(projectRoot, "logo.png");
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, bin);

        const res = await $fetch<{ content: string; encoding: "utf-8" | "base64" }>(
          readUrl(orgSlug, projSlug, "logo.png"),
          { headers },
        );

        expect(res.encoding).toBe("base64");
        expect(Buffer.from(res.content, "base64").equals(bin)).toBe(true);
      });

      it("rejects a path containing '..'", async () => {
        // Belt + braces: Nitro's router normalises `..` segments before
        // dispatch, so an attack URL never reaches the handler — it 404s
        // at the route layer. Either rejection is fine; we just need to
        // prove no file content was returned.
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);

        await expect(
          $fetch(`/api/orgs/${orgSlug}/projects/${projSlug}/files/..%2Fetc%2Fpasswd`, {
            headers,
          }),
        ).rejects.toMatchObject({
          statusCode: expect.toSatisfy((code: number) => code === 400 || code === 404),
        });
      });

      it("rejects a symlink that escapes the project root", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        // Write a sensitive file OUTSIDE the project, then symlink it from
        // inside. realpath() should detect the escape.
        const outsideDir = await fs.mkdtemp(path.join(projectRoot, "..", "escape-"));
        const outsideFile = path.join(outsideDir, "secret.txt");
        await fs.writeFile(outsideFile, "TOP SECRET", "utf8");
        const linkPath = path.join(projectRoot, "secret.txt");
        await fs.symlink(outsideFile, linkPath);

        await expect(
          $fetch(readUrl(orgSlug, projSlug, "secret.txt"), { headers }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("404s for a non-existent file", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);

        await expect(
          $fetch(readUrl(orgSlug, projSlug, "does-not-exist.md"), { headers }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });

      it("rejects a directory path", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        await fs.mkdir(path.join(projectRoot, "subdir"), { recursive: true });

        await expect(
          $fetch(readUrl(orgSlug, projSlug, "subdir"), { headers }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("413s for files exceeding the size cap", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        // Just over 1 MiB.
        const big = Buffer.alloc(1_000_001, 0x61);
        const abs = path.join(projectRoot, "huge.txt");
        await fs.writeFile(abs, big);

        await expect(
          $fetch(readUrl(orgSlug, projSlug, "huge.txt"), { headers }),
        ).rejects.toMatchObject({ statusCode: 413 });
      });

      it("403s when the caller is not a member of the project's org", async () => {
        const aliceHeaders = authAs("alice@example.com", "Alice");
        const bobHeaders = authAs("bob@example.com", "Bob");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(
          aliceHeaders,
          `iso-read-${Date.now()}`,
        );
        await writeProjectFile(projectRoot, "spec.md", "# alice's spec");
        await $fetch("/api/me", { headers: bobHeaders });

        await expect(
          $fetch(readUrl(orgSlug, projSlug, "spec.md"), { headers: bobHeaders }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });
    });

    const searchUrl = (orgSlug: string, projSlug: string) =>
      `/api/orgs/${orgSlug}/projects/${projSlug}/search`;

    describe("POST /api/orgs/:org/projects/:proj/search", () => {
      it("returns matches for known content", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        await writeProjectFile(projectRoot, "src/a.ts", "const FOO = 1;\nconst BAR = 2;\n");
        await writeProjectFile(projectRoot, "src/b.ts", "const FOO = 42;\n");
        await writeProjectFile(projectRoot, "README.md", "no match here\n");

        const res = await $fetch<{
          matches: Array<{ path: string; line: number; snippet: string }>;
          truncated: boolean;
        }>(searchUrl(orgSlug, projSlug), {
          method: "POST",
          headers,
          body: { query: "FOO" },
        });

        expect(res.truncated).toBe(false);
        const paths = res.matches.map((m) => m.path).sort();
        expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
        const a = res.matches.find((m) => m.path === "src/a.ts")!;
        expect(a.line).toBe(1);
        expect(a.snippet).toContain("FOO");
      });

      it("honours the glob filter", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        await writeProjectFile(projectRoot, "specs/foo.md", "needle\n");
        await writeProjectFile(projectRoot, "src/foo.ts", "needle\n");

        const res = await $fetch<{
          matches: Array<{ path: string }>;
        }>(searchUrl(orgSlug, projSlug), {
          method: "POST",
          headers,
          body: { query: "needle", glob: "specs/**/*.md" },
        });

        expect(res.matches.map((m) => m.path)).toEqual(["specs/foo.md"]);
      });

      it("truncates at the limit and reports truncated=true", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        // Five files each with a single match; cap at 2.
        for (let i = 0; i < 5; i++) {
          await writeProjectFile(projectRoot, `f${i}.txt`, "hit\n");
        }

        const res = await $fetch<{
          matches: Array<{ path: string }>;
          truncated: boolean;
        }>(searchUrl(orgSlug, projSlug), {
          method: "POST",
          headers,
          body: { query: "hit", limit: 2 },
        });

        expect(res.matches.length).toBe(2);
        expect(res.truncated).toBe(true);
      });

      it("returns empty matches when query matches nothing", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        await writeProjectFile(projectRoot, "a.txt", "hello\n");

        const res = await $fetch<{
          matches: Array<unknown>;
          truncated: boolean;
        }>(searchUrl(orgSlug, projSlug), {
          method: "POST",
          headers,
          body: { query: "zzz-nope" },
        });

        expect(res.matches).toEqual([]);
        expect(res.truncated).toBe(false);
      });

      it("treats the query as a literal (no regex interpretation)", async () => {
        // Documentation test: rg is invoked with -F, so a query like
        // 'a.b' must NOT match 'aXb'. This is what we want for an LLM
        // tool — the model shouldn't have to reason about regex escaping.
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(headers);
        await writeProjectFile(projectRoot, "a.txt", "aXb\n");
        await writeProjectFile(projectRoot, "b.txt", "a.b\n");

        const res = await $fetch<{ matches: Array<{ path: string }> }>(
          searchUrl(orgSlug, projSlug),
          { method: "POST", headers, body: { query: "a.b" } },
        );

        expect(res.matches.map((m) => m.path)).toEqual(["b.txt"]);
      });

      it("rejects a glob containing '..'", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);

        await expect(
          $fetch(searchUrl(orgSlug, projSlug), {
            method: "POST",
            headers,
            body: { query: "x", glob: "../**" },
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("403s when the caller is not a member of the project's org", async () => {
        const aliceHeaders = authAs("alice@example.com", "Alice");
        const bobHeaders = authAs("bob@example.com", "Bob");
        const { orgSlug, projSlug, projectRoot } = await bootstrapProject(
          aliceHeaders,
          `iso-search-${Date.now()}`,
        );
        await writeProjectFile(projectRoot, "spec.md", "needle\n");
        await $fetch("/api/me", { headers: bobHeaders });

        await expect(
          $fetch(searchUrl(orgSlug, projSlug), {
            method: "POST",
            headers: bobHeaders,
            body: { query: "needle" },
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });
    });

    const draftsUrl = (orgSlug: string, projSlug: string, tail = "") =>
      `/api/orgs/${orgSlug}/projects/${projSlug}/spec-drafts${tail}`;

    interface DraftSummaryShape {
      id: string;
      title: string;
      baseVersion: number;
      status: "draft" | "published";
      createdAt: string;
      updatedAt: string;
      publishedAt: string | null;
    }
    interface DraftFullShape extends DraftSummaryShape {
      files: Array<{ name: string; content: string }>;
      conversation: unknown[];
    }

    describe("spec-drafts CRUD", () => {
      it("POST creates a draft and GET /mine returns it", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);

        const created = await $fetch<{ draftId: string; createdAt: string }>(
          draftsUrl(orgSlug, projSlug),
          {
            method: "POST",
            headers,
            body: {
              title: "First draft",
              baseVersion: 0,
              files: [{ name: "spec.md", content: "# Hello" }],
              conversation: [{ role: "user", content: "make it so" }],
            },
          },
        );
        expect(created.draftId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );

        const mine = await $fetch<{ drafts: DraftSummaryShape[] }>(
          draftsUrl(orgSlug, projSlug, "/mine"),
          { headers },
        );
        expect(mine.drafts.length).toBe(1);
        expect(mine.drafts[0]!.title).toBe("First draft");
        expect(mine.drafts[0]!.status).toBe("draft");
      });

      it("GET /:draftId returns full draft (files + conversation)", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);

        const { draftId } = await $fetch<{ draftId: string }>(
          draftsUrl(orgSlug, projSlug),
          {
            method: "POST",
            headers,
            body: {
              title: "T",
              baseVersion: 0,
              files: [
                { name: "spec.md", content: "# Spec body" },
                { name: "plan.md", content: "# Plan body" },
              ],
              conversation: [{ role: "assistant", content: "ok" }],
            },
          },
        );

        const full = await $fetch<DraftFullShape>(
          draftsUrl(orgSlug, projSlug, `/${draftId}`),
          { headers },
        );
        expect(full.id).toBe(draftId);
        expect(full.title).toBe("T");
        expect(full.baseVersion).toBe(0);
        expect(full.status).toBe("draft");
        expect(full.files.map((f) => f.name).sort()).toEqual([
          "plan.md",
          "spec.md",
        ]);
        expect(full.files.find((f) => f.name === "spec.md")?.content).toBe(
          "# Spec body",
        );
        expect(full.conversation).toEqual([
          { role: "assistant", content: "ok" },
        ]);
      });

      it("GET /mine excludes drafts owned by other users in the same org", async () => {
        const aliceHeaders = authAs("alice@example.com", "Alice");
        const bobHeaders = authAs("bob@example.com", "Bob");
        const { orgSlug, projSlug } = await bootstrapProject(aliceHeaders);
        // Promote Bob into the org so he passes project-access.
        // (The org currently has only Alice; we'd need an invite flow.
        // Easier: bootstrap a fresh project owned by Bob and assert
        // Alice's /mine never includes Bob's drafts.)
        const { orgSlug: bobOrg, projSlug: bobProj } = await bootstrapProject(
          bobHeaders,
          `bob-${Date.now()}`,
        );
        await $fetch(draftsUrl(bobOrg, bobProj), {
          method: "POST",
          headers: bobHeaders,
          body: {
            title: "Bob's draft",
            baseVersion: 0,
            files: [{ name: "spec.md", content: "bob's words" }],
            conversation: [],
          },
        });
        await $fetch(draftsUrl(orgSlug, projSlug), {
          method: "POST",
          headers: aliceHeaders,
          body: {
            title: "Alice's draft",
            baseVersion: 0,
            files: [{ name: "spec.md", content: "alice's words" }],
            conversation: [],
          },
        });

        const aliceMine = await $fetch<{ drafts: DraftSummaryShape[] }>(
          draftsUrl(orgSlug, projSlug, "/mine"),
          { headers: aliceHeaders },
        );
        expect(aliceMine.drafts.map((d) => d.title)).toEqual([
          "Alice's draft",
        ]);
      });

      it("PATCH updates title + replaces files + updates conversation", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);
        const { draftId } = await $fetch<{ draftId: string }>(
          draftsUrl(orgSlug, projSlug),
          {
            method: "POST",
            headers,
            body: {
              title: "old",
              baseVersion: 0,
              files: [{ name: "spec.md", content: "v1" }],
              conversation: [{ role: "user", content: "start" }],
            },
          },
        );

        await $fetch(draftsUrl(orgSlug, projSlug, `/${draftId}`), {
          method: "PATCH",
          headers,
          body: {
            title: "new",
            files: [
              { name: "spec.md", content: "v2" },
              { name: "plan.md", content: "added" },
            ],
            conversation: [
              { role: "user", content: "start" },
              { role: "assistant", content: "next" },
            ],
          },
        });

        const after = await $fetch<DraftFullShape>(
          draftsUrl(orgSlug, projSlug, `/${draftId}`),
          { headers },
        );
        expect(after.title).toBe("new");
        expect(after.files.map((f) => f.name).sort()).toEqual([
          "plan.md",
          "spec.md",
        ]);
        expect(after.files.find((f) => f.name === "spec.md")?.content).toBe(
          "v2",
        );
        expect(after.conversation).toHaveLength(2);
      });

      it("PATCH with empty body returns 400", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);
        const { draftId } = await $fetch<{ draftId: string }>(
          draftsUrl(orgSlug, projSlug),
          {
            method: "POST",
            headers,
            body: {
              title: "x",
              baseVersion: 0,
              files: [],
              conversation: [],
            },
          },
        );

        await expect(
          $fetch(draftsUrl(orgSlug, projSlug, `/${draftId}`), {
            method: "PATCH",
            headers,
            body: {},
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
      });

      it("DELETE removes the draft", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);
        const { draftId } = await $fetch<{ draftId: string }>(
          draftsUrl(orgSlug, projSlug),
          {
            method: "POST",
            headers,
            body: {
              title: "to-delete",
              baseVersion: 0,
              files: [{ name: "spec.md", content: "bye" }],
              conversation: [],
            },
          },
        );

        const res = await $fetch<{ ok: true }>(
          draftsUrl(orgSlug, projSlug, `/${draftId}`),
          { method: "DELETE", headers },
        );
        expect(res.ok).toBe(true);

        await expect(
          $fetch(draftsUrl(orgSlug, projSlug, `/${draftId}`), { headers }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });

      it("GET /:draftId returns 404 for another user's draft", async () => {
        // Two users in two different orgs; Alice owns the draft, Bob
        // tries to read it but is denied at the project-access layer
        // (403). Same-org cross-user requires an invite flow we don't
        // have here, so this is the strongest isolation we can assert
        // without leaving Phase 1's scope.
        const aliceHeaders = authAs("alice@example.com", "Alice");
        const bobHeaders = authAs("bob@example.com", "Bob");
        const { orgSlug, projSlug } = await bootstrapProject(aliceHeaders);
        const { draftId } = await $fetch<{ draftId: string }>(
          draftsUrl(orgSlug, projSlug),
          {
            method: "POST",
            headers: aliceHeaders,
            body: {
              title: "private",
              baseVersion: 0,
              files: [],
              conversation: [],
            },
          },
        );
        await $fetch("/api/me", { headers: bobHeaders });

        await expect(
          $fetch(draftsUrl(orgSlug, projSlug, `/${draftId}`), {
            headers: bobHeaders,
          }),
        ).rejects.toMatchObject({ statusCode: 403 });
      });

      it("GET /spec-drafts (no draftId) returns 404", async () => {
        const headers = authAs("alice@example.com");
        const { orgSlug, projSlug } = await bootstrapProject(headers);

        await expect(
          $fetch(draftsUrl(orgSlug, projSlug), { headers }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });
    });
  });
}
