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

  getProjectDir(slug) {
    return path.join(this.rootDir, slug);
  }

  getProjectPaths(slug) {
    const baseDir = this.getProjectDir(slug);
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

  async createProject(slug, title, specContent, metaExtras = {}) {
    const paths = this.getProjectPaths(slug);
    if (await exists(paths.baseDir)) {
      throw new Error(`Project '${slug}' already exists.`);
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

  async saveArtifact(slug, type, value) {
    const paths = this.getProjectPaths(slug);
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

  async loadArtifact(slug, type, fallback = null) {
    const paths = this.getProjectPaths(slug);
    const targetPath = paths[type];
    if (!targetPath) {
      throw new Error(`Unknown artifact type '${type}'.`);
    }
    if (targetPath.endsWith(".json")) {
      return readJson(targetPath, fallback);
    }
    return readText(targetPath, fallback ?? "");
  }

  async listProjects() {
    await this.initRoot();
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const meta = await this.loadArtifact(entry.name, "meta", null);
      const run = await this.loadArtifact(entry.name, "run", null);
      projects.push({
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
