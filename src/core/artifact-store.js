import path from "node:path";
import { SPECIFYR_DIR } from "./constants.js";
import { ensureDir, exists, readJson, readText, resolveFromCwd, writeJson, writeText } from "../utils/fs.js";

export class ArtifactStore {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.rootDir = resolveFromCwd(cwd, SPECIFYR_DIR);
  }

  async initRoot() {
    await ensureDir(this.rootDir);
  }

  getOrgDir(orgId) {
    return path.join(this.rootDir, orgId);
  }

  getProjectDir(orgId, slug) {
    return path.join(this.getOrgDir(orgId), slug);
  }

  getProjectPaths(orgId, slug) {
    const baseDir = this.getProjectDir(orgId, slug);
    return {
      baseDir,
      spec: path.join(baseDir, "spec.md"),
      plan: path.join(baseDir, "plan.md"),
      tasks: path.join(baseDir, "tasks.md"),
      run: path.join(baseDir, "run.json"),
      meta: path.join(baseDir, "meta.json"),
      results: path.join(baseDir, "results.json"),
      approvals: path.join(baseDir, "approvals.json")
    };
  }

  async createProject(orgId, slug, title, specContent, metaExtras = {}) {
    const paths = this.getProjectPaths(orgId, slug);
    if (await exists(paths.baseDir)) {
      throw new Error(`Project '${slug}' already exists in org.`);
    }
    await ensureDir(paths.baseDir);
    await writeText(paths.spec, specContent);
    await writeText(paths.plan, "");
    await writeText(paths.tasks, "");
    await writeJson(paths.meta, {
      slug,
      title,
      createdAt: new Date().toISOString(),
      ...metaExtras
    });
    await writeJson(paths.results, { tasks: {}, summary: null });
    await writeJson(paths.approvals, []);
  }

  async saveArtifact(orgId, slug, type, value) {
    const paths = this.getProjectPaths(orgId, slug);
    const targetPath = paths[type];
    if (!targetPath) {
      throw new Error(`Unknown artifact type '${type}'.`);
    }
    if (targetPath.endsWith(".json")) {
      await writeJson(targetPath, value);
      return;
    }
    await writeText(targetPath, value);
  }

  async loadArtifact(orgId, slug, type, fallback = null) {
    const paths = this.getProjectPaths(orgId, slug);
    const targetPath = paths[type];
    if (!targetPath) {
      throw new Error(`Unknown artifact type '${type}'.`);
    }
    if (targetPath.endsWith(".json")) {
      return readJson(targetPath, fallback);
    }
    return readText(targetPath, fallback ?? "");
  }

  // Lists every project across every org on disk. Returns entries with both
  // `orgId` (from the directory layout) and `slug`. Callers that only care
  // about one org should filter the result, or use `listProjectsForOrg`.
  async listProjects() {
    await this.initRoot();
    const fs = await import("node:fs/promises");
    const orgEntries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const projects = [];
    for (const orgEntry of orgEntries) {
      if (!orgEntry.isDirectory()) continue;
      const orgId = orgEntry.name;
      const projectEntries = await fs.readdir(this.getOrgDir(orgId), { withFileTypes: true }).catch(() => []);
      for (const entry of projectEntries) {
        if (!entry.isDirectory()) continue;
        const meta = await this.loadArtifact(orgId, entry.name, "meta", null);
        const run = await this.loadArtifact(orgId, entry.name, "run", null);
        projects.push({
          orgId,
          slug: entry.name,
          title: meta?.title ?? entry.name,
          description: meta?.description ?? "",
          projectRoot: meta?.projectRoot ?? null,
          specifyInit: meta?.specifyInit ?? null,
          run
        });
      }
    }
    return projects.sort((left, right) =>
      left.orgId === right.orgId ? left.slug.localeCompare(right.slug) : left.orgId.localeCompare(right.orgId)
    );
  }

  async listProjectsForOrg(orgId) {
    const fs = await import("node:fs/promises");
    const orgDir = this.getOrgDir(orgId);
    const entries = await fs.readdir(orgDir, { withFileTypes: true }).catch(() => []);
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await this.loadArtifact(orgId, entry.name, "meta", null);
      const run = await this.loadArtifact(orgId, entry.name, "run", null);
      projects.push({
        orgId,
        slug: entry.name,
        title: meta?.title ?? entry.name,
        description: meta?.description ?? "",
        projectRoot: meta?.projectRoot ?? null,
        specifyInit: meta?.specifyInit ?? null,
        run
      });
    }
    return projects.sort((left, right) => left.slug.localeCompare(right.slug));
  }
}
