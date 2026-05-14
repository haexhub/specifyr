/**
 * Per-project git-remote configuration stored alongside the workflow
 * id in <dataDir>/.specifyr/<slug>/meta.json under the `repository`
 * key. The associated PAT lives encrypted in secrets-store under the
 * reserved key `__git_remote_token` (see secrets-store.ts).
 */

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

async function writeMeta(
  slug: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(
    metaPath(slug),
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
  slug: string,
): Promise<RepositoryConfig | null> {
  try {
    const meta = await readMeta(slug);
    const repo = (meta as { repository?: unknown }).repository;
    return isRepoConfig(repo)
      ? {
          url: repo.url,
          branch: repo.branch,
          username: repo.username,
        }
      : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function setProjectRepository(
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
  const meta = await readMeta(slug);
  meta.repository = {
    url: cfg.url,
    branch: cfg.branch,
    username: cfg.username,
  };
  await writeMeta(slug, meta);
}

export async function clearProjectRepository(slug: string): Promise<void> {
  try {
    const meta = await readMeta(slug);
    if (!("repository" in meta)) return;
    delete (meta as Record<string, unknown>).repository;
    await writeMeta(slug, meta);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
