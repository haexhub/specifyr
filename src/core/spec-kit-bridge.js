import path from "node:path";
import { SPECIFY_DIR } from "./constants.js";
import { ensureDir, exists, readText, writeJson, writeText } from "../utils/fs.js";

export class SpecKitBridge {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.rootDir = path.join(cwd, SPECIFY_DIR);
  }

  async init() {
    await ensureDir(path.join(this.rootDir, "memory"));
    await ensureDir(path.join(this.rootDir, "specs"));
    await writeText(
      path.join(this.rootDir, "memory", "constitution.md"),
      "# speculoss Constitution\n\n- Work from explicit specs.\n- Preserve approval gates.\n- Prefer observable state transitions over hidden agent behavior.\n"
    );
  }

  async syncProject(slug, artifacts) {
    const projectDir = path.join(this.rootDir, "specs", slug);
    await ensureDir(projectDir);
    await writeText(path.join(projectDir, "spec.md"), artifacts.spec ?? "");
    await writeText(path.join(projectDir, "plan.md"), artifacts.plan ?? "");
    await writeText(path.join(projectDir, "tasks.md"), artifacts.tasks ?? "");
    await writeJson(path.join(projectDir, "meta.json"), {
      slug,
      title: artifacts.title,
      syncedAt: new Date().toISOString()
    });
    await writeText(
      path.join(projectDir, "README.md"),
      `# ${artifacts.title}\n\nThis directory mirrors speculoss artifacts for spec-kit-style workflows.\n`
    );
  }

  async readSpec(slug) {
    return readText(path.join(this.rootDir, "specs", slug, "spec.md"), "");
  }

  async hasProject(slug) {
    return exists(path.join(this.rootDir, "specs", slug));
  }
}
