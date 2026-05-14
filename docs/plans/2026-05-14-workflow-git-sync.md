# Workflow Git-Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Jeden Projekt-Workflow (spec-kit oder Extension-Workflow) mit einer optionalen Git-Remote-URL verknüpfen, sodass Workflow-Fortschritt (Artefakte unter `.specify/`, geänderte Files, Step-State) automatisch gepushed und manuell gepulled werden kann — provider-agnostisch (GitHub, GitLab, Bitbucket/Atlassian, Gitea, self-hosted).

**Architecture:** Wir erweitern das pro-Projekt `meta.json` um ein `repository`-Objekt (URL + Branch + verschlüsselter Token-Verweis). Das eigentliche `.git`-Verzeichnis existiert bereits (`project-creation.ts:71` legt `git init -b main` an); wir fügen Remote-Konfiguration, Auto-Commit und Push/Pull-Endpoints hinzu. Token wird im bestehenden verschlüsselten `secrets-store` unter dem reservierten Key `__git_remote_token` abgelegt. Push erfolgt via `git` CLI (analog `git-clone.ts`-Pattern mit `runCommand`), nicht via Library — kein neuer NPM-Dependency.

**Tech Stack:** Nuxt 4 + Vue 3 (TS), Drizzle/Postgres (nicht für diese Funktion benötigt), `node:child_process` für `git`-Aufrufe, bestehender AES-256-GCM-Secrets-Store, `node:test` für Tests, shadcn-vue Komponenten.

**Out of Scope (Phase 1):**
- SSH-Keys (nur HTTPS+PAT)
- OAuth-Login per Provider (User pastet Token)
- Provider-spezifische Features (PR-Erstellung, Issue-Sync, Webhooks) — kommen ggf. in Phase 2 via Octokit-Adapter
- Conflict-Resolution-UI bei Pull-Konflikten (zunächst nur Fehlermeldung, manueller CLI-Fix)

---

## Design Decisions

| Entscheidung | Rationale |
|---|---|
| Repo-Config in `meta.json` (nicht DB) | Konsistent mit existierendem `workflow`-Feld; pro-Projekt-Scope; einfache File-Backups |
| HTTPS + Personal Access Token | Universell für alle vier genannten Provider; keine SSH-Key-Verwaltung nötig |
| Token im `secrets-store` (Key `__git_remote_token`) | Bestehende Infra, AES-256-GCM, `chmod 600`, nie in Logs/Specs |
| `git` CLI via `runCommand` | Konsistent mit `git-clone.ts`; vermeidet zusätzlichen Dep (`simple-git`/`isomorphic-git`); SSRF-Schutz bereits in `git-clone.ts` etabliert, wir wiederverwenden die Validierungs-Helfer |
| Auto-Commit + Auto-Push nach Step-Save (debounced 5s) | "Jeder Fortschritt sofort gespeichert" — User-Anforderung. Debounce verhindert Push-Storms bei schnellen Edits |
| Pull nur manuell | Vermeidet überraschende Merge-Konflikte mitten in Agent-Runs |
| Push verwendet ephemeral `credential.helper` über `-c` Flag | Token landet nie in `.git/config` oder `~/.git-credentials` (Sicherheitspattern aus `git-clone.ts`) |

---

## Phase 1 — Data Layer

### Task 1.1: meta.json Schema erweitern

**Files:**
- Modify: `server/shared/utils/workflows.ts` — Typ `ProjectMeta` + Helper
- Create: `server/shared/utils/project-repository.ts` — Getter/Setter
- Test: `tests/db/project-repository.test.ts`

**Step 1: Failing test schreiben**

`tests/db/project-repository.test.ts`:
```ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tmpDataDir: string;

before(async () => {
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "specifyr-repo-"));
  process.env.SPECIFYR_DATA_DIR = tmpDataDir;
  process.env.SPECIFYR_SECRET_KEY = crypto.randomBytes(32).toString("hex");
});

after(async () => {
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // seed minimal meta.json for slug "demo"
  const dir = path.join(tmpDataDir, ".specifyr", "demo");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ description: "x", workflow: "spec-kit", projectRoot: "/tmp/demo" }, null, 2),
  );
});

test("getProjectRepository returns null when not configured", async () => {
  const { getProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  assert.equal(await getProjectRepository("demo"), null);
});

test("setProjectRepository persists url + branch + username", async () => {
  const { setProjectRepository, getProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  await setProjectRepository("demo", {
    url: "https://github.com/acme/demo.git",
    branch: "main",
    username: "acme-bot",
  });
  const cfg = await getProjectRepository("demo");
  assert.deepEqual(cfg, {
    url: "https://github.com/acme/demo.git",
    branch: "main",
    username: "acme-bot",
  });
});

test("setProjectRepository validates https-only", async () => {
  const { setProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  await assert.rejects(
    () => setProjectRepository("demo", { url: "git@github.com:acme/demo.git", branch: "main", username: "x" }),
    /only https/i,
  );
});

test("clearProjectRepository removes repository key from meta", async () => {
  const { setProjectRepository, clearProjectRepository, getProjectRepository } = await import(
    "../../server/shared/utils/project-repository.ts"
  );
  await setProjectRepository("demo", { url: "https://x/y.git", branch: "main", username: "u" });
  await clearProjectRepository("demo");
  assert.equal(await getProjectRepository("demo"), null);
});
```

**Step 2: Test fails verifizieren**

Run: `pnpm test -- project-repository`
Expected: FAIL — `project-repository.ts` existiert nicht.

**Step 3: Minimal-Implementation**

`server/shared/utils/project-repository.ts`:
```ts
import path from "node:path";
import fs from "node:fs/promises";
import { dataDir } from "./data-dirs";

export interface RepositoryConfig {
  url: string;
  branch: string;
  username: string;
}

function metaPath(slug: string): string {
  return path.join(dataDir(), ".specifyr", slug, "meta.json");
}

async function readMeta(slug: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(metaPath(slug), "utf8"));
}

async function writeMeta(slug: string, meta: Record<string, unknown>): Promise<void> {
  await fs.writeFile(metaPath(slug), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function isRepoConfig(v: unknown): v is RepositoryConfig {
  return (
    !!v && typeof v === "object" &&
    typeof (v as RepositoryConfig).url === "string" &&
    typeof (v as RepositoryConfig).branch === "string" &&
    typeof (v as RepositoryConfig).username === "string"
  );
}

export async function getProjectRepository(slug: string): Promise<RepositoryConfig | null> {
  try {
    const meta = await readMeta(slug);
    const repo = (meta as { repository?: unknown }).repository;
    return isRepoConfig(repo) ? repo : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function setProjectRepository(slug: string, cfg: RepositoryConfig): Promise<void> {
  const parsed = new URL(cfg.url);
  if (parsed.protocol !== "https:") throw new Error("only https:// remote URLs are supported");
  if (parsed.username || parsed.password) throw new Error("remote URL must not contain inline credentials");
  const meta = await readMeta(slug);
  meta.repository = { url: cfg.url, branch: cfg.branch, username: cfg.username };
  await writeMeta(slug, meta);
}

export async function clearProjectRepository(slug: string): Promise<void> {
  const meta = await readMeta(slug);
  delete (meta as Record<string, unknown>).repository;
  await writeMeta(slug, meta);
}
```

**Step 4: Tests grün**

Run: `pnpm test -- project-repository`
Expected: PASS (4/4).

**Step 5: Commit**

```bash
git add server/shared/utils/project-repository.ts tests/db/project-repository.test.ts
git commit -m "feat(repo): meta.json schema and helpers for per-project git remote"
```

---

### Task 1.2: Reservierten Secret-Key etablieren

**Files:**
- Modify: `server/shared/utils/secrets-store.ts` — exportierte Konstante
- Modify: `server/projects/api/projects/[slug]/secrets.post.ts` — Block reservierter Keys
- Test: `tests/db/secrets-store.test.ts` — neuer Testfall

**Step 1: Failing test schreiben** (an existierende `secrets-store.test.ts` anhängen)

```ts
test("setSecret/getSecret roundtrip for git token", async () => {
  const { setSecret, getProjectSecrets, GIT_REMOTE_TOKEN_KEY } = await import(
    "../../server/shared/utils/secrets-store.ts"
  );
  await setSecret("demo", GIT_REMOTE_TOKEN_KEY, "ghp_testtoken123");
  const secrets = await getProjectSecrets("demo");
  assert.equal(secrets[GIT_REMOTE_TOKEN_KEY], "ghp_testtoken123");
});
```

**Step 2: Fails verifizieren**

Run: `pnpm test -- secrets-store`
Expected: FAIL — `GIT_REMOTE_TOKEN_KEY` nicht exportiert.

**Step 3: Implementierung**

In `secrets-store.ts` exportieren:
```ts
export const GIT_REMOTE_TOKEN_KEY = "__git_remote_token";
```

In `secrets.post.ts` (öffentlicher Secrets-POST-Endpoint) blocken:
```ts
import { GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";

// in handler nach parseBody:
if (key === GIT_REMOTE_TOKEN_KEY) {
  throw createError({
    statusCode: 400,
    statusMessage: "Reserved key — use /api/projects/:slug/repository to manage the git token.",
  });
}
```

**Step 4: Tests grün**

Run: `pnpm test -- secrets-store`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/shared/utils/secrets-store.ts server/projects/api/projects/\[slug\]/secrets.post.ts tests/db/secrets-store.test.ts
git commit -m "feat(repo): reserved secret key for git remote token"
```

---

## Phase 2 — Git Operations

### Task 2.1: Generische `runGitInProject`-Utility

**Files:**
- Create: `server/shared/utils/git-remote.ts` — `configureRemote`, `runGitInProject`
- Test: `tests/db/git-remote.test.ts`

Diese Datei kapselt das gemeinsame Pattern: Token-Injection via `-c http.extraHeader=` (kein Token auf Disk), Timeout, AbortController, Working-Directory.

**Step 1: Failing test schreiben**

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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

test("configureRemote sets origin to provided URL", async () => {
  const repo = path.join(tmpDir, "repo");
  await fs.mkdir(repo);
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) =>
    spawn("git", ["init", "-b", "main"], { cwd: repo }).on("exit", (c) =>
      c === 0 ? resolve() : reject(new Error("init")),
    ),
  );

  const { configureRemote } = await import("../../server/shared/utils/git-remote.ts");
  await configureRemote(repo, "https://github.com/acme/demo.git");

  const result = await new Promise<string>((resolve) => {
    let out = "";
    const p = spawn("git", ["remote", "-v"], { cwd: repo });
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("exit", () => resolve(out));
  });
  assert.match(result, /origin\s+https:\/\/github\.com\/acme\/demo\.git/);
});

test("configureRemote rejects non-https url", async () => {
  const repo = path.join(tmpDir, "repo-ssh");
  await fs.mkdir(repo, { recursive: true });
  const { configureRemote } = await import("../../server/shared/utils/git-remote.ts");
  await assert.rejects(
    () => configureRemote(repo, "git@github.com:acme/demo.git"),
    /https/i,
  );
});
```

**Step 2: Fails verifizieren**

Run: `pnpm test -- git-remote`
Expected: FAIL.

**Step 3: Implementierung**

`server/shared/utils/git-remote.ts`:
```ts
import { spawn } from "node:child_process";

export interface RunGitOptions {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  /** Bearer token; injected as http.extraHeader per-invocation, not stored on disk. */
  bearerToken?: string;
}

export interface RunGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function runGitInProject(opts: RunGitOptions): Promise<RunGitResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const flagArgs: string[] = [];
  if (opts.bearerToken) {
    // Base64-Bearer in http.extraHeader — git speichert das nirgends.
    const b64 = Buffer.from(`x-access-token:${opts.bearerToken}`).toString("base64");
    flagArgs.push("-c", `http.extraHeader=Authorization: Basic ${b64}`);
  }
  const child = spawn("git", [...flagArgs, ...opts.args], { cwd: opts.cwd });
  const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const code: number | null = await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(t);
  // Redact token if it somehow leaked into stderr/stdout.
  if (opts.bearerToken) {
    stdout = stdout.replaceAll(opts.bearerToken, "***");
    stderr = stderr.replaceAll(opts.bearerToken, "***");
  }
  return { ok: code === 0, stdout, stderr };
}

export async function configureRemote(repoPath: string, url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("only https remotes are supported");
  if (parsed.username || parsed.password) throw new Error("remote URL must not contain inline credentials");

  const existing = await runGitInProject({ cwd: repoPath, args: ["remote"] });
  if (existing.stdout.split("\n").includes("origin")) {
    const upd = await runGitInProject({ cwd: repoPath, args: ["remote", "set-url", "origin", url] });
    if (!upd.ok) throw new Error(upd.stderr || "failed to update remote");
  } else {
    const add = await runGitInProject({ cwd: repoPath, args: ["remote", "add", "origin", url] });
    if (!add.ok) throw new Error(add.stderr || "failed to add remote");
  }
}
```

**Step 4: Tests grün**

Run: `pnpm test -- git-remote`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/shared/utils/git-remote.ts tests/db/git-remote.test.ts
git commit -m "feat(repo): git-remote helpers with header-only token injection"
```

---

### Task 2.2: SSRF/Private-IP-Validierung wiederverwenden

**Files:**
- Modify: `server/shared/utils/git-clone.ts` — `assertSafeUrl`, `assertHostNotPrivate` exportieren
- Modify: `server/shared/utils/git-remote.ts` — Import + Aufruf in `configureRemote` & `runGitInProject` (vor jedem Netz-Op)
- Test: `tests/db/git-remote.test.ts` — Reject `https://10.0.0.1/...`

**Step 1: Failing test ergänzen**

```ts
test("configureRemote rejects private IPv4", async () => {
  const repo = path.join(tmpDir, "repo-private");
  await fs.mkdir(repo, { recursive: true });
  const { configureRemote } = await import("../../server/shared/utils/git-remote.ts");
  await assert.rejects(
    () => configureRemote(repo, "https://10.0.0.1/x.git"),
    /private|reserved/i,
  );
});
```

**Step 2: Fails verifizieren**

Run: `pnpm test -- git-remote`
Expected: FAIL — private IPs werden aktuell durchgelassen.

**Step 3: Implementierung**

In `git-clone.ts`: `export { assertSafeUrl, assertHostNotPrivate };`
In `git-remote.ts` `configureRemote` und einem neuen `assertRemoteSafe(url)` Helper aufrufen.

**Step 4: Tests grün**

Run: `pnpm test -- git-remote`
Expected: PASS (3/3).

**Step 5: Commit**

```bash
git add server/shared/utils/git-clone.ts server/shared/utils/git-remote.ts tests/db/git-remote.test.ts
git commit -m "feat(repo): reuse git-clone SSRF guards for remote configuration"
```

---

### Task 2.3: Commit + Push Utility

**Files:**
- Modify: `server/shared/utils/git-remote.ts` — `commitAndPush(slug)`
- Test: `tests/db/git-remote.test.ts` — Integration mit lokalem bare-Repo

**Step 1: Failing test schreiben**

```ts
test("commitAndPush stages, commits and pushes pending changes to remote", async () => {
  // 1. bare upstream
  const upstream = path.join(tmpDir, "upstream.git");
  await fs.mkdir(upstream);
  await runOk("git", ["init", "--bare", "-b", "main"], upstream);

  // 2. simulate a project root
  const projectRoot = path.join(tmpDir, "project-cap");
  await fs.mkdir(projectRoot);
  await runOk("git", ["init", "-b", "main"], projectRoot);
  await runOk("git", ["config", "user.email", "x@y"], projectRoot);
  await runOk("git", ["config", "user.name", "x"], projectRoot);
  await fs.writeFile(path.join(projectRoot, "README.md"), "hello\n");
  await runOk("git", ["add", "."], projectRoot);
  await runOk("git", ["commit", "-m", "init"], projectRoot);
  await runOk("git", ["remote", "add", "origin", `file://${upstream}`], projectRoot);

  // 3. new change → commitAndPush
  await fs.writeFile(path.join(projectRoot, "step.md"), "progress\n");
  const { commitAndPush } = await import("../../server/shared/utils/git-remote.ts");
  const result = await commitAndPush({
    projectRoot,
    branch: "main",
    message: "step: constitution complete",
    remoteUrlOverride: `file://${upstream}`, // skip SSRF for file:// tests
  });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.pushed, true);

  // 4. clone upstream and verify file exists
  const verify = path.join(tmpDir, "verify");
  await runOk("git", ["clone", `file://${upstream}`, verify]);
  assert.equal(await fs.readFile(path.join(verify, "step.md"), "utf8"), "progress\n");
});

test("commitAndPush is a no-op when no changes are pending", async () => {
  // similar setup, but no new file change before commitAndPush
  // ... assert result.pushed === false, result.ok === true
});

async function runOk(cmd: string, args: string[], cwd: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) =>
    spawn(cmd, args, { cwd }).on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exit ${c}`)))),
  );
}
```

**Step 2: Fails verifizieren**

Run: `pnpm test -- git-remote`
Expected: FAIL — `commitAndPush` nicht definiert.

**Step 3: Implementierung**

In `git-remote.ts` ergänzen:
```ts
export interface CommitAndPushOptions {
  projectRoot: string;
  branch: string;
  message: string;
  bearerToken?: string;
  /** For tests only. */
  remoteUrlOverride?: string;
}

export async function commitAndPush(opts: CommitAndPushOptions): Promise<{ ok: boolean; pushed: boolean; stderr: string }> {
  // 1. status --porcelain → if empty, nothing to do
  const status = await runGitInProject({ cwd: opts.projectRoot, args: ["status", "--porcelain"] });
  if (!status.ok) return { ok: false, pushed: false, stderr: status.stderr };
  if (status.stdout.trim().length === 0) return { ok: true, pushed: false, stderr: "" };

  const add = await runGitInProject({ cwd: opts.projectRoot, args: ["add", "-A"] });
  if (!add.ok) return { ok: false, pushed: false, stderr: add.stderr };

  const commit = await runGitInProject({ cwd: opts.projectRoot, args: ["commit", "-m", opts.message] });
  if (!commit.ok) return { ok: false, pushed: false, stderr: commit.stderr };

  const pushArgs = ["push", "origin", `HEAD:${opts.branch}`];
  const push = await runGitInProject({
    cwd: opts.projectRoot,
    args: pushArgs,
    bearerToken: opts.bearerToken,
    timeoutMs: 120_000,
  });
  if (!push.ok) return { ok: false, pushed: false, stderr: push.stderr };
  return { ok: true, pushed: true, stderr: "" };
}
```

**Step 4: Tests grün**

Run: `pnpm test -- git-remote`
Expected: PASS (all).

**Step 5: Commit**

```bash
git add server/shared/utils/git-remote.ts tests/db/git-remote.test.ts
git commit -m "feat(repo): commitAndPush helper with no-op on clean tree"
```

---

### Task 2.4: Fetch + Pull Utility

**Files:**
- Modify: `server/shared/utils/git-remote.ts` — `pullFromRemote`
- Test: `tests/db/git-remote.test.ts`

**Step 1: Failing test**

Setup: zwei lokale Repos, beide am gleichen Upstream. Repo A pushed, Repo B `pullFromRemote` und sieht die Änderung.

**Step 2: Fails verifizieren** → FAIL (Funktion nicht definiert)

**Step 3: Implementierung**

```ts
export interface PullOptions {
  projectRoot: string;
  branch: string;
  bearerToken?: string;
}

export async function pullFromRemote(opts: PullOptions): Promise<{ ok: boolean; updated: boolean; stderr: string }> {
  // Refuse if working tree dirty — caller must decide what to do.
  const status = await runGitInProject({ cwd: opts.projectRoot, args: ["status", "--porcelain"] });
  if (!status.ok) return { ok: false, updated: false, stderr: status.stderr };
  if (status.stdout.trim().length > 0) {
    return { ok: false, updated: false, stderr: "working tree has uncommitted changes" };
  }
  const before = await runGitInProject({ cwd: opts.projectRoot, args: ["rev-parse", "HEAD"] });
  const pull = await runGitInProject({
    cwd: opts.projectRoot,
    args: ["pull", "--ff-only", "origin", opts.branch],
    bearerToken: opts.bearerToken,
    timeoutMs: 120_000,
  });
  if (!pull.ok) return { ok: false, updated: false, stderr: pull.stderr };
  const after = await runGitInProject({ cwd: opts.projectRoot, args: ["rev-parse", "HEAD"] });
  return { ok: true, updated: before.stdout.trim() !== after.stdout.trim(), stderr: "" };
}
```

**Step 4: Tests grün** → PASS

**Step 5: Commit**

```bash
git add server/shared/utils/git-remote.ts tests/db/git-remote.test.ts
git commit -m "feat(repo): pullFromRemote with ff-only and dirty-tree guard"
```

---

## Phase 3 — API Endpoints

### Task 3.1: GET/PUT `/api/projects/:slug/repository`

**Files:**
- Create: `server/projects/api/projects/[slug]/repository.get.ts`
- Create: `server/projects/api/projects/[slug]/repository.put.ts`
- Create: `server/projects/api/projects/[slug]/repository.delete.ts`
- Test: `tests/api/repository.api.test.ts`

**Step 1: Failing test (Nitro Test-Utility)**

E2E-Test via `vitest`-Setup analog `tests/api/api.e2e.test.ts`:
- PUT mit Body `{ url, branch, username, token }` → 200, persistiert meta + secret
- GET → liefert `{ url, branch, username, hasToken: true }` (Token nie zurückgeben)
- PUT mit `git@github.com:...` → 400
- DELETE → meta-Eintrag entfernt, Token aus Secrets-Store entfernt

**Step 2: Fails verifizieren**

Run: `pnpm test:e2e -- repository`
Expected: FAIL.

**Step 3: Implementierung**

`repository.put.ts`:
```ts
import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { setProjectRepository } from "@su/project-repository";
import { setSecret, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { parseBody, parseParams, projectSlugParam } from "@su/validation";

const bodySchema = z.object({
  url: z.string().url().startsWith("https://"),
  branch: z.string().trim().min(1).max(255).default("main"),
  username: z.string().trim().min(1).max(255),
  token: z.string().min(1).max(4096),
});

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);
  const body = await parseBody(event, bodySchema);
  await setProjectRepository(slug, { url: body.url, branch: body.branch, username: body.username });
  await setSecret(slug, GIT_REMOTE_TOKEN_KEY, body.token);
  return { ok: true };
});
```

`repository.get.ts`:
```ts
import { assertProjectExists } from "@su/specifyr-stores";
import { getProjectRepository } from "@su/project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { parseParams, projectSlugParam } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);
  const cfg = await getProjectRepository(slug);
  if (!cfg) return { configured: false };
  const secrets = await getProjectSecrets(slug);
  return {
    configured: true,
    url: cfg.url,
    branch: cfg.branch,
    username: cfg.username,
    hasToken: !!secrets[GIT_REMOTE_TOKEN_KEY],
  };
});
```

`repository.delete.ts`:
```ts
import { assertProjectExists } from "@su/specifyr-stores";
import { clearProjectRepository } from "@su/project-repository";
import { deleteSecret, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { parseParams, projectSlugParam } from "@su/validation";

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);
  await clearProjectRepository(slug);
  await deleteSecret(slug, GIT_REMOTE_TOKEN_KEY);
  return { ok: true };
});
```

**Step 4: Tests grün**

Run: `pnpm test:e2e -- repository`
Expected: PASS.

**Step 5: Commit**

```bash
git add server/projects/api/projects/\[slug\]/repository.*.ts tests/api/repository.api.test.ts
git commit -m "feat(repo): CRUD endpoints for per-project repository config"
```

---

### Task 3.2: POST `/api/projects/:slug/repository/push`

**Files:**
- Create: `server/projects/api/projects/[slug]/repository/push.post.ts`
- Test: `tests/api/repository.api.test.ts` — neuer Block

**Step 1: Failing test**

- Setup: lokales bare upstream, PUT-konfiguriert via Endpoint, dann POST `/push`
- Erwarten: 200 `{ ok: true, pushed: true|false, message }`
- 400 wenn `configured: false`

**Step 2: Fails verifizieren** → FAIL

**Step 3: Implementierung**

```ts
import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { getProjectRepository } from "@su/project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { configureRemote, commitAndPush } from "@su/git-remote";
import { parseBody, parseParams, projectSlugParam } from "@su/validation";
import path from "node:path";
import { projectsDir } from "@su/data-dirs";

const bodySchema = z.object({
  message: z.string().trim().min(1).max(2048).default("specifyr: workflow progress"),
});

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  await assertProjectExists(slug);
  const { message } = await parseBody(event, bodySchema);
  const cfg = await getProjectRepository(slug);
  if (!cfg) throw createError({ statusCode: 400, statusMessage: "Repository not configured." });
  const secrets = await getProjectSecrets(slug);
  const token = secrets[GIT_REMOTE_TOKEN_KEY];
  if (!token) throw createError({ statusCode: 400, statusMessage: "Repository token missing." });
  const projectRoot = path.join(projectsDir(), slug);
  await configureRemote(projectRoot, cfg.url);
  const result = await commitAndPush({ projectRoot, branch: cfg.branch, message, bearerToken: token });
  if (!result.ok) throw createError({ statusCode: 502, statusMessage: result.stderr || "push failed" });
  return { ok: true, pushed: result.pushed };
});
```

**Step 4: Tests grün** → PASS

**Step 5: Commit**

```bash
git add server/projects/api/projects/\[slug\]/repository/push.post.ts tests/api/repository.api.test.ts
git commit -m "feat(repo): push endpoint commits and pushes pending workflow changes"
```

---

### Task 3.3: POST `/api/projects/:slug/repository/pull`

Analog Task 3.2. Bei `result.updated: true` zusätzlich Step-State neu einlesen (falls die Pull-Antwort später downstream Auswirkungen hat — für Phase 1 ist der reine Pull ausreichend, UI re-fetcht ohnehin).

**Step 5: Commit**

```bash
git commit -m "feat(repo): pull endpoint with ff-only and dirty-tree guard"
```

---

### Task 3.4: POST `/api/projects/:slug/repository/test`

Verifiziert Credentials ohne zu pushen: `git ls-remote --heads <url>` mit Token-Header. Liefert die fünf neuesten Refs zurück.

**Files:** `server/projects/api/projects/[slug]/repository/test.post.ts`

```ts
// body: { url, username, token } — wird NICHT persistiert, nur getestet
// uses runGitInProject({ args: ["ls-remote", "--heads", url], bearerToken }) in a tmp cwd
// returns { ok, refs?: string[], message? }
```

**Step 5: Commit**

```bash
git commit -m "feat(repo): test-connection endpoint with ls-remote"
```

---

## Phase 4 — Auto-Sync auf Workflow-Fortschritt

### Task 4.1: Step-Save-Hook identifizieren

**Files (Read-Only Recherche, kein Commit):**
- `server/projects/api/projects/[slug]/steps/*.ts` — wo speichert die UI Step-Status?
- `server/shared/utils/specifyr-stores.ts` — File-basierter Step-Store
- `server/shared/utils/run-manager.ts` — wo werden Agent-Runs abgeschlossen?

**Aufgabe:** Eine kurze Notiz im Plan-Dokument ergänzen, *wo* der Auto-Push-Hook einzuhängen ist. Erwartung: Nach dem `listSteps()`-Update (Step abgeschlossen) und nach `run-manager`-Run-Completion. Konkrete Funktion notieren mit `file:line`-Referenz.

**Kein Code-Change in diesem Task** — nur Recherche → Plan-Dokument-Update.

---

### Task 4.2: `triggerAutoPush(slug)` mit Debounce

**Files:**
- Create: `server/shared/utils/repository-autosync.ts`
- Test: `tests/db/repository-autosync.test.ts`

**Verhalten:**
- Debounce-Fenster: 5000 ms pro Slug
- Wiederholte Aufrufe innerhalb des Fensters resetten den Timer
- Bei Trigger: `getProjectRepository(slug)` → wenn `null`, no-op
- Ansonsten: `configureRemote` + `commitAndPush` mit Default-Message
- Fehler ins `pino` / `consola` loggen, **nicht werfen** (Background-Task darf User-Action nicht failen)

**Step 1: Failing test**

```ts
test("triggerAutoPush is a no-op when repository not configured", async () => { /* ... */ });
test("triggerAutoPush debounces multiple calls within 5s", async () => {
  // call three times rapidly, advance fake timers, verify commitAndPush called once
});
test("triggerAutoPush logs but does not throw on git error", async () => { /* ... */ });
```

**Step 2-5:** Implementierung + Commit.

```bash
git commit -m "feat(repo): debounced auto-push utility"
```

---

### Task 4.3: Auto-Push in Step-Completion einbauen

**Files:**
- Modify: (Ergebnis aus Task 4.1 — vermutlich `server/projects/api/projects/[slug]/steps/[id].patch.ts` oder ähnlich)
- Modify: `server/shared/utils/run-manager.ts` — bei `runFinalized`-Event

**Step 1: Failing test (E2E)**

In `tests/api/repository.api.test.ts`:
- Setup mit konfiguriertem Repo
- POST step-completion
- Warten auf debounce + push
- Verifizieren via `git log` im Upstream, dass neuer Commit existiert

**Step 2-5:** Hook-Aufruf + Commit.

```bash
git commit -m "feat(repo): auto-push on step completion and run finalize"
```

---

## Phase 5 — UI

### Task 5.1: Repository-Settings-Section

**Files:**
- Create: `app/pages/specs/[slug]/repository.vue`
- Modify: `app/pages/specs/[slug]/index.vue` — Link in Sidebar

**Verhalten:**
- Wenn nicht konfiguriert: Formular mit `url`, `branch`, `username`, `token`-Feldern, "Test connection"-Button, "Save"
- Wenn konfiguriert: Anzeige + "Remove", "Update token", "Pull now", "Push now"
- "Test connection" → POST `/repository/test` → zeigt `refs` oder Fehler
- Token-Feld immer leer beim Laden (`hasToken` als Indikator)

**Komponenten:** Bestehende shadcn-vue Inputs/Buttons. Form-Validation via `vee-validate` falls schon eingesetzt; sonst inline.

**Step 1-5:** Komponente bauen, "happy path" durchklicken im Dev-Server, Commit.

```bash
git commit -m "feat(repo): UI for per-project repository configuration"
```

---

### Task 5.2: Status-Badge im Project-Header

**Files:**
- Modify: `app/pages/specs/[slug]/index.vue` — Header

**Verhalten:**
- Polling `/repository`-Endpoint alle 30 s
- Badge: "✓ Synced HH:MM" (grün) / "Pushing…" (gelb) / "⚠ Push failed" (rot, tooltip mit Fehler)
- Klick → springt nach `repository.vue`

`lastSyncedAt` muss in `meta.json` mitgepflegt werden — Task 2.3 ergänzen oder hier separat persistieren (Empfehlung: in der `commitAndPush`-Funktion `meta.json:repository.lastPushedAt` mit aktualisieren).

```bash
git commit -m "feat(repo): sync status badge in project header"
```

---

## Phase 6 — Initial Clone (Optional, Phase 2 wenn Zeit knapp)

### Task 6.1: "Create project from existing repo" im Projekt-Wizard

**Files:**
- Modify: `app/pages/projects/new.vue` (oder Pfad-Äquivalent)
- Modify: `server/shared/utils/project-creation.ts` — neuer Param `cloneFrom?: { url; branch; username; token }`

**Verhalten:**
- Im Wizard zweite Option: "Import existing repository"
- Backend: statt `specify init` + `git init` zuerst `gitClone(...)` (existierende `git-clone.ts`), dann `meta.json` schreiben, Token in `secrets-store` persistieren
- `getProjectStepIds` liest Workflow-State aus dem geclonten `.specify/`-Verzeichnis

**Step 5: Commit**

```bash
git commit -m "feat(repo): clone-from-remote flow in project creation wizard"
```

---

## Verification Strategy

Nach jeder Phase:
1. `pnpm typecheck` (bzw. Nuxt-equivalent)
2. `pnpm test` (Unit) und `pnpm test:e2e` (Integration)
3. `pnpm dev` und manueller UI-Check der relevanten Section (Phasen 5/6)

Vor Merge in `main`:
- `superpowers:requesting-code-review` — Fokus auf Token-Handling (kein Token in Logs, kein Token in `.git/config`, kein Token in Push-Stderr)
- Sicherheitsreview: SSRF-Tests bestehen, private IPs werden geblockt, `file://`-URLs werden geblockt (außer in Tests)

## Notes for Future Phases

- **Provider-spezifische Hooks (Phase 2):** Octokit/GitLab-Adapter für PR-Erstellung am Ende eines Workflow-Runs, Issue-Linking aus `tasks.graph.json`, Webhook-Empfänger für `pull` bei externem Push
- **SSH-Support:** Eigene Key-Verwaltung im Vault-Schema (`agent_vault`), `ssh-agent`-Forwarding
- **Conflict-Resolution-UI:** Bei nicht-FF-Pull zeigt UI die divergenten Commits, bietet "Theirs"/"Ours"/"Manual"-Auswahl

---

**Acceptance Criteria (Phase 1 — Goal):**
1. ✅ Im Project-Settings kann User HTTPS-URL + Branch + Username + Token eintragen
2. ✅ "Test connection" verifiziert die Credentials ohne zu pushen
3. ✅ Nach jeder Step-Completion wird der Workflow-Stand automatisch (debounced) gepushed
4. ✅ Manueller "Push now"-Button funktioniert
5. ✅ Manueller "Pull now"-Button funktioniert (ff-only, blockt bei dirty tree)
6. ✅ Token nie in Logs / Config-Files / Stderr / Specs
7. ✅ Private IPs / Non-HTTPS / inline-credentials URLs werden abgelehnt
8. ✅ Beim Anlegen eines neuen Projekts kann optional eine existierende Repo-URL angegeben werden (klont statt initiiert) — Phase 6
