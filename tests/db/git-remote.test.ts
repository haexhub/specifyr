/**
 * git-remote utilities: runGitInProject (per-call token via http.extraHeader),
 * configureRemote (set/update origin), commitAndPush (no-op on clean tree),
 * pullFromRemote (ff-only, dirty-tree guard).
 *
 * Tests use file:// upstream repos so we don't need network access.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "specifyr-git-remote-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function runOk(cmd: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "pipe" });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("exit", (c) =>
      c === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exit ${c}: ${stderr}`)),
    );
  });
}

async function runOut(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let out = "";
    const p = spawn(cmd, args, { cwd, stdio: "pipe" });
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("exit", (c) =>
      c === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${c}`)),
    );
  });
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await runOk("git", ["init", "-b", "main"], dir);
  await runOk("git", ["config", "user.email", "x@y"], dir);
  await runOk("git", ["config", "user.name", "x"], dir);
}

test("configureRemote sets origin to provided URL", async () => {
  const repo = path.join(tmpDir, "repo");
  await initRepo(repo);

  const { configureRemote } = await import(
    "../../server/shared/utils/git-remote.ts"
  );
  await configureRemote(repo, "https://github.com/acme/demo.git");

  const out = await runOut("git", ["remote", "-v"], repo);
  assert.match(out, /origin\s+https:\/\/github\.com\/acme\/demo\.git/);
});

test("configureRemote replaces an existing origin", async () => {
  const repo = path.join(tmpDir, "repo-replace");
  await initRepo(repo);
  await runOk(
    "git",
    ["remote", "add", "origin", "https://github.com/old/repo.git"],
    repo,
  );

  const { configureRemote } = await import(
    "../../server/shared/utils/git-remote.ts"
  );
  await configureRemote(repo, "https://github.com/new/repo.git");

  const out = await runOut("git", ["remote", "-v"], repo);
  assert.match(out, /origin\s+https:\/\/github\.com\/new\/repo\.git/);
  assert.doesNotMatch(out, /old\/repo\.git/);
});

test("configureRemote rejects non-https url", async () => {
  const repo = path.join(tmpDir, "repo-ssh");
  await initRepo(repo);
  const { configureRemote } = await import(
    "../../server/shared/utils/git-remote.ts"
  );
  await assert.rejects(
    () => configureRemote(repo, "git@github.com:acme/demo.git"),
    /https/i,
  );
});

test("configureRemote rejects URL with inline credentials", async () => {
  const repo = path.join(tmpDir, "repo-creds");
  await initRepo(repo);
  const { configureRemote } = await import(
    "../../server/shared/utils/git-remote.ts"
  );
  await assert.rejects(
    () => configureRemote(repo, "https://user:tok@github.com/x/y.git"),
    /credentials/i,
  );
});

test("configureRemote rejects private IPv4 hosts", async () => {
  const repo = path.join(tmpDir, "repo-private");
  await initRepo(repo);
  const { configureRemote } = await import(
    "../../server/shared/utils/git-remote.ts"
  );
  await assert.rejects(
    () => configureRemote(repo, "https://10.0.0.1/x.git"),
    /allowed/i,
  );
});

test("configureRemote rejects localhost", async () => {
  const repo = path.join(tmpDir, "repo-localhost");
  await initRepo(repo);
  const { configureRemote } = await import(
    "../../server/shared/utils/git-remote.ts"
  );
  await assert.rejects(
    () => configureRemote(repo, "https://localhost/x.git"),
    /allowed/i,
  );
});

test("commitAndPush stages, commits and pushes pending changes to remote", async () => {
  process.env.SPECIFYR_ALLOW_FILE_REMOTES = "1";
  const upstream = path.join(tmpDir, "upstream-cap.git");
  await fs.mkdir(upstream);
  await runOk("git", ["init", "--bare", "-b", "main"], upstream);

  const projectRoot = path.join(tmpDir, "project-cap");
  await initRepo(projectRoot);
  await fs.writeFile(path.join(projectRoot, "README.md"), "hello\n");
  await runOk("git", ["add", "."], projectRoot);
  await runOk("git", ["commit", "-m", "init"], projectRoot);
  await runOk("git", ["remote", "add", "origin", `file://${upstream}`], projectRoot);

  await fs.writeFile(path.join(projectRoot, "step.md"), "progress\n");

  const { commitAndPush } = await import(
    "../../server/shared/utils/git-remote.ts"
  );
  const result = await commitAndPush({
    projectRoot,
    branch: "main",
    message: "step: constitution complete",
  });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.pushed, true);

  const verify = path.join(tmpDir, "verify-cap");
  await runOk("git", ["clone", `file://${upstream}`, verify], tmpDir);
  assert.equal(
    await fs.readFile(path.join(verify, "step.md"), "utf8"),
    "progress\n",
  );
});

test("commitAndPush is a no-op when working tree is clean", async () => {
  process.env.SPECIFYR_ALLOW_FILE_REMOTES = "1";
  const upstream = path.join(tmpDir, "upstream-noop.git");
  await fs.mkdir(upstream);
  await runOk("git", ["init", "--bare", "-b", "main"], upstream);

  const projectRoot = path.join(tmpDir, "project-noop");
  await initRepo(projectRoot);
  await fs.writeFile(path.join(projectRoot, "README.md"), "hello\n");
  await runOk("git", ["add", "."], projectRoot);
  await runOk("git", ["commit", "-m", "init"], projectRoot);
  await runOk("git", ["remote", "add", "origin", `file://${upstream}`], projectRoot);
  await runOk("git", ["push", "origin", "HEAD:main"], projectRoot);

  const { commitAndPush } = await import(
    "../../server/shared/utils/git-remote.ts"
  );
  const result = await commitAndPush({
    projectRoot,
    branch: "main",
    message: "should not commit anything",
  });
  assert.equal(result.ok, true);
  assert.equal(result.pushed, false);
});

test("configureRemote rejects file:// remotes unless explicitly allowed", async () => {
  const repo = path.join(tmpDir, "repo-file");
  await initRepo(repo);
  const previous = process.env.SPECIFYR_ALLOW_FILE_REMOTES;
  delete process.env.SPECIFYR_ALLOW_FILE_REMOTES;
  try {
    const { configureRemote } = await import(
      "../../server/shared/utils/git-remote.ts"
    );
    await assert.rejects(
      () => configureRemote(repo, "file:///tmp/upstream.git"),
      /file:\/\/ remotes are not allowed/i,
    );
  } finally {
    if (previous === undefined)
      delete process.env.SPECIFYR_ALLOW_FILE_REMOTES;
    else process.env.SPECIFYR_ALLOW_FILE_REMOTES = previous;
  }
});
