import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { WorktreeManager } from "../src/core/worktree-manager.js";

function git(cwd, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
      else resolve(stdout.trim());
    });
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function createGitRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await fs.writeFile(path.join(dir, "seed.txt"), "seed");
  await git(dir, ["add", "seed.txt"]);
  await git(dir, ["commit", "-m", "seed"]);
  return dir;
}

test("create() makes a new worktree at <repo>/.worktrees/<slug>", async () => {
  const repo = await createGitRepo();
  const wm = new WorktreeManager({ repoRoot: repo });

  const result = await wm.create({ taskSlug: "task-1", baseBranch: "main" });
  assert.match(result.worktreePath, /\.worktrees\/task-1$/);
  assert.equal(result.branch, "company/task-1");

  // worktree dir exists with seed file (inherited from base)
  const seed = await fs.readFile(path.join(result.worktreePath, "seed.txt"), "utf8");
  assert.equal(seed, "seed");

  // cleanup
  await wm.remove({ taskSlug: "task-1", branch: result.branch });
});

test("create() rejects an already-existing worktree slug", async () => {
  const repo = await createGitRepo();
  const wm = new WorktreeManager({ repoRoot: repo });
  await wm.create({ taskSlug: "task-2", baseBranch: "main" });
  await assert.rejects(
    () => wm.create({ taskSlug: "task-2", baseBranch: "main" }),
    /already exists/i
  );
  await wm.remove({ taskSlug: "task-2", branch: "company/task-2" });
});

test("remove() deletes worktree dir and branch", async () => {
  const repo = await createGitRepo();
  const wm = new WorktreeManager({ repoRoot: repo });

  const r = await wm.create({ taskSlug: "task-3", baseBranch: "main" });
  await wm.remove({ taskSlug: "task-3", branch: r.branch });

  // worktree dir is gone
  await assert.rejects(() => fs.stat(r.worktreePath), /ENOENT/);
  // branch is gone
  const branches = await git(repo, ["branch", "--list", "company/task-3"]);
  assert.equal(branches, "");
});

test("list() returns active worktrees with their branches", async () => {
  const repo = await createGitRepo();
  const wm = new WorktreeManager({ repoRoot: repo });
  await wm.create({ taskSlug: "task-4", baseBranch: "main" });
  await wm.create({ taskSlug: "task-5", baseBranch: "main" });

  const list = await wm.list();
  const slugs = list.map((w) => w.taskSlug).sort();
  assert.deepEqual(slugs, ["task-4", "task-5"]);

  await wm.remove({ taskSlug: "task-4", branch: "company/task-4" });
  await wm.remove({ taskSlug: "task-5", branch: "company/task-5" });
});

test("rejects task slug with invalid characters", async () => {
  const repo = await createGitRepo();
  const wm = new WorktreeManager({ repoRoot: repo });
  await assert.rejects(
    () => wm.create({ taskSlug: "../escape", baseBranch: "main" }),
    /invalid taskSlug/
  );
});
