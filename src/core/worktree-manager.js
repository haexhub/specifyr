/**
 * WorktreeManager — provisions per-task git worktrees so multiple agents can
 * mutate filesystem state without interfering with each other.
 *
 * Each task with `isolation: worktree` gets a sibling directory under
 * `<repo>/.worktrees/<task-slug>/` and a dedicated branch `company/<task-slug>`.
 * On task completion (or failure), the runtime calls remove() to clean up.
 *
 * The taskSlug must match `^[a-z0-9][a-z0-9-_]*$` to avoid path traversal /
 * branch-name shenanigans.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const SAFE_SLUG = /^[a-z0-9][a-z0-9-_]*$/;
const BRANCH_PREFIX = "company/";

export class WorktreeManager {
  constructor({ repoRoot, branchPrefix = BRANCH_PREFIX } = {}) {
    if (!repoRoot) throw new Error("WorktreeManager: repoRoot required");
    this.repoRoot = repoRoot;
    this.branchPrefix = branchPrefix;
  }

  /**
   * Create an isolated worktree + branch for the given task.
   * @returns {Promise<{worktreePath: string, branch: string}>}
   */
  async create({ taskSlug, baseBranch = "main" }) {
    if (!SAFE_SLUG.test(taskSlug)) {
      throw new Error(`invalid taskSlug '${taskSlug}': must match ${SAFE_SLUG}`);
    }
    const worktreesRoot = path.join(this.repoRoot, ".worktrees");
    const worktreePath = path.join(worktreesRoot, taskSlug);
    const branch = `${this.branchPrefix}${taskSlug}`;

    try {
      await fs.stat(worktreePath);
      throw new Error(`worktree '${worktreePath}' already exists`);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    await fs.mkdir(worktreesRoot, { recursive: true });
    await this.#git(["worktree", "add", "-b", branch, worktreePath, baseBranch]);

    return { worktreePath, branch };
  }

  /**
   * Remove the worktree and its branch. Idempotent: missing entries are tolerated.
   */
  async remove({ taskSlug, branch }) {
    if (!SAFE_SLUG.test(taskSlug)) {
      throw new Error(`invalid taskSlug '${taskSlug}': must match ${SAFE_SLUG}`);
    }
    const worktreePath = path.join(this.repoRoot, ".worktrees", taskSlug);
    try {
      await this.#git(["worktree", "remove", "--force", worktreePath]);
    } catch {
      // already gone — ignore
    }
    if (branch) {
      try {
        await this.#git(["branch", "-D", branch]);
      } catch {
        // already gone — ignore
      }
    }
  }

  /**
   * @returns {Promise<Array<{taskSlug: string, branch: string, path: string}>>}
   */
  async list() {
    const out = await this.#git(["worktree", "list", "--porcelain"]);
    const blocks = out.split("\n\n").filter(Boolean);
    const items = [];
    for (const block of blocks) {
      const wtMatch = block.match(/^worktree (.+)$/m);
      const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
      if (!wtMatch) continue;
      const wtPath = wtMatch[1];
      // Skip the main repo
      if (path.resolve(wtPath) === path.resolve(this.repoRoot)) continue;
      const branch = branchMatch?.[1];
      // Only consider those inside our managed prefix
      const slug = path.basename(wtPath);
      const expectedBranch = `${this.branchPrefix}${slug}`;
      if (branch !== expectedBranch) continue;
      items.push({ taskSlug: slug, branch, path: wtPath });
    }
    return items;
  }

  #git(args) {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd: this.repoRoot, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
        } else {
          resolve(stdout.trim());
        }
      });
      child.stdin.end();
    });
  }
}
