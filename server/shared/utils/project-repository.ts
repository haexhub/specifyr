/**
 * Per-project git-remote configuration stored alongside the workflow
 * id in <dataDir>/.specifyr/<orgId>/<slug>/meta.json under the
 * `repository` key. The associated PAT lives encrypted in
 * secrets-store under the reserved key `__git_remote_token`
 * (see secrets-store.ts).
 */

import path from "node:path";
import fs from "node:fs/promises";
import { projectArtifactsDir } from "./data-dirs";

export interface RepositoryConfig {
  url: string;
  branch: string;
  username: string;
  /** ISO timestamp of the last successful push, written by commitAndPush. */
  lastPushedAt?: string;
}

// Per-(org,slug) serialization for meta.json mutations. Concurrent
// read-modify-write callers (e.g. setLastPushedAt racing with
// setProjectRepository) would otherwise clobber each other's fields.
// Mirrors the queue pattern used in secrets-store.ts.
const writeQueues = new Map<string, Promise<void>>();

function queueKey(orgId: string, slug: string): string {
  return `${orgId}/${slug}`;
}

function enqueueMetaWrite(
  orgId: string,
  slug: string,
  op: () => Promise<void>,
): Promise<void> {
  const k = queueKey(orgId, slug);
  const prev = writeQueues.get(k) ?? Promise.resolve();
  const next = prev.then(op, op);
  writeQueues.set(
    k,
    next.finally(() => {
      if (writeQueues.get(k) === next) writeQueues.delete(k);
    }),
  );
  return next;
}

function metaPath(orgId: string, slug: string): string {
  return path.join(projectArtifactsDir(orgId, slug), "meta.json");
}

async function readMeta(orgId: string, slug: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(metaPath(orgId, slug), "utf8"));
}

async function writeMeta(
  orgId: string,
  slug: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(
    metaPath(orgId, slug),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
}

function isRepoConfig(v: unknown): v is RepositoryConfig {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as RepositoryConfig).url === "string" &&
    typeof (v as RepositoryConfig).branch === "string" &&
    typeof (v as RepositoryConfig).username === "string"
  );
}

export async function getProjectRepository(
  orgId: string,
  slug: string,
): Promise<RepositoryConfig | null> {
  try {
    const meta = await readMeta(orgId, slug);
    const repo = (meta as { repository?: unknown }).repository;
    if (!isRepoConfig(repo)) return null;
    const lastPushedAt = (repo as RepositoryConfig).lastPushedAt;
    return {
      url: repo.url,
      branch: repo.branch,
      username: repo.username,
      ...(typeof lastPushedAt === "string" ? { lastPushedAt } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Record the timestamp of a successful push. No-op when no
 * repository is configured (e.g. user disconnected mid-push).
 */
export function setLastPushedAt(orgId: string, slug: string, iso: string): Promise<void> {
  return enqueueMetaWrite(orgId, slug, async () => {
    try {
      const meta = await readMeta(orgId, slug);
      const repo = (meta as { repository?: unknown }).repository;
      if (!isRepoConfig(repo)) return;
      (meta as Record<string, unknown>).repository = {
        ...repo,
        lastPushedAt: iso,
      };
      await writeMeta(orgId, slug, meta);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  });
}

export async function setProjectRepository(
  orgId: string,
  slug: string,
  cfg: RepositoryConfig,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(cfg.url);
  } catch {
    throw new Error("only https:// remote URLs are supported");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("only https:// remote URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("remote URL must not contain inline credentials");
  }
  await enqueueMetaWrite(orgId, slug, async () => {
    const meta = await readMeta(orgId, slug);
    meta.repository = {
      url: cfg.url,
      branch: cfg.branch,
      username: cfg.username,
    };
    await writeMeta(orgId, slug, meta);
  });
}

export function clearProjectRepository(orgId: string, slug: string): Promise<void> {
  return enqueueMetaWrite(orgId, slug, async () => {
    try {
      const meta = await readMeta(orgId, slug);
      if (!("repository" in meta)) return;
      delete (meta as Record<string, unknown>).repository;
      await writeMeta(orgId, slug, meta);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  });
}

/**
 * Run an arbitrary read-modify-write against meta.json under the same
 * per-(orgId,slug) lock as `setProjectRepository`/`setLastPushedAt`, so
 * unrelated fields (workflow, repository, …) can't clobber each other
 * under concurrent requests. Throws if meta.json is missing — callers
 * that need create-on-missing must handle ENOENT themselves.
 */
export function mutateProjectMeta(
  orgId: string,
  slug: string,
  mutate: (meta: Record<string, unknown>) => Record<string, unknown> | void,
): Promise<void> {
  return enqueueMetaWrite(orgId, slug, async () => {
    const meta = await readMeta(orgId, slug);
    const next = mutate(meta) ?? meta;
    await writeMeta(orgId, slug, next as Record<string, unknown>);
  });
}
