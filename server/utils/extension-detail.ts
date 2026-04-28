import { getExtensionCatalog, getLastCatalogMeta, type CatalogExtension } from "./extension-catalog";
import {
  getLocalExtensionDetail,
  type ExtensionCommandEntry,
  type ExtensionHookEntry
} from "./local-extension";

export interface CatalogExtensionDetail extends CatalogExtension {
  download_url?: string;
  homepage?: string;
  repository?: string;
  documentation?: string;
  changelog?: string;
  releaseVersion?: string;
  releasePublishedAt?: string;
}

export interface ExtensionDependent {
  id: string;
  name?: string;
  version?: string;
}

export interface ExtensionDetailPayload {
  extension: CatalogExtensionDetail;
  dependents: ExtensionDependent[];
  readmeContent: string;
  /** Indicates whether the detail was resolved from the community catalog or a local path. */
  source?: "local" | "catalog";
  /** Absolute path to the extension root. Only set when source === "local". */
  localPath?: string;
  /**
   * Full command list parsed from the extension manifest. Populated for local extensions;
   * optional for catalog extensions depending on whether the catalog JSON happens to carry
   * the detailed array (most do; the catalog util passes whatever `pageProps` contains).
   */
  commands?: ExtensionCommandEntry[];
  /**
   * Event → command bindings parsed from the extension manifest. Same shape rules as `commands`.
   */
  hooks?: ExtensionHookEntry[];
}

interface DetailNextJsonData {
  pageProps: ExtensionDetailPayload;
}

const CATALOG_BASE = "https://speckit-community.github.io/extensions";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const detailCache = new Map<string, { fetchedAt: number; payload: ExtensionDetailPayload }>();

export async function getExtensionDetail(slug: string): Promise<ExtensionDetailPayload> {
  // Locally-registered slugs take precedence over the community catalog.
  // We intentionally do NOT cache local detail — filesystem edits should surface immediately.
  const local = await getLocalExtensionDetail(slug);
  if (local) return local;

  const now = Date.now();
  const cached = detailCache.get(slug);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.payload;
  }

  // Ensure the buildId is known — the catalog util owns it and caches it.
  await getExtensionCatalog();
  const meta = getLastCatalogMeta();
  if (!meta) {
    throw new Error("Catalog metadata unavailable — cannot resolve buildId.");
  }

  const url = `${CATALOG_BASE}/_next/data/${meta.buildId}/${encodeURIComponent(slug)}.json`;
  const res = await fetch(url, { headers: { "user-agent": "speculoss/0.1" } });
  if (res.status === 404) {
    throw new Error(`Extension '${slug}' not found in catalog.`);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch detail JSON: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as DetailNextJsonData;
  const payload = data?.pageProps;
  if (!payload?.extension) {
    const keys = data && typeof data === "object" ? Object.keys(data).join(", ") : typeof data;
    throw new Error(`Unexpected detail payload shape (top-level keys: ${keys})`);
  }
  const finalPayload: ExtensionDetailPayload = { ...payload, source: "catalog" };
  detailCache.set(slug, { fetchedAt: now, payload: finalPayload });
  return finalPayload;
}
