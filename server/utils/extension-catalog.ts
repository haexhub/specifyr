interface ExtensionRequires {
  speckit_version?: string;
}

interface ExtensionProvides {
  commands?: number;
  hooks?: number;
}

export interface CatalogExtension {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  tags?: string[];
  repository?: string;
  homepage?: string;
  documentation?: string;
  license?: string;
  verified?: boolean;
  downloads?: number;
  stars?: number;
  requires?: ExtensionRequires;
  provides?: ExtensionProvides;
  updated_at?: string;
  created_at?: string;
}

interface CatalogNextPageProps {
  extensions: CatalogExtension[];
}

// Shape embedded in the HTML as <script id="__NEXT_DATA__">
interface CatalogNextHtmlData {
  props: { pageProps: CatalogNextPageProps };
  buildId: string;
}

// Shape returned by /_next/data/<buildId>/<page>.json (no props/buildId wrapper)
interface CatalogNextJsonData {
  pageProps: CatalogNextPageProps;
}

const CATALOG_BASE = "https://speckit-community.github.io/extensions";
const ALL_EXTENSIONS_URL = `${CATALOG_BASE}/all-extensions`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cached:
  | {
      fetchedAt: number;
      buildId: string;
      extensions: CatalogExtension[];
    }
  | null = null;

let inflight: Promise<CatalogExtension[]> | null = null;

async function extractBuildId(): Promise<string> {
  const res = await fetch(ALL_EXTENSIONS_URL, { headers: { "user-agent": "specops/0.1" } });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${ALL_EXTENSIONS_URL}: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  // __NEXT_DATA__ is a <script id="__NEXT_DATA__" type="application/json">{...}</script>
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]!) as CatalogNextHtmlData;
      if (parsed.buildId) return parsed.buildId;
    } catch {
      // fall through to the alternate regex
    }
  }
  const alt = html.match(/"buildId":"([^"]+)"/);
  if (alt) return alt[1]!;
  throw new Error("Could not extract Next.js buildId from community catalog HTML.");
}

async function loadFresh(): Promise<CatalogExtension[]> {
  const buildId = await extractBuildId();
  const url = `${CATALOG_BASE}/_next/data/${buildId}/all-extensions.json`;
  const res = await fetch(url, { headers: { "user-agent": "specops/0.1" } });
  if (!res.ok) {
    throw new Error(`Failed to fetch catalog JSON: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as CatalogNextJsonData;
  const extensions = data?.pageProps?.extensions;
  if (!Array.isArray(extensions)) {
    const keys = data && typeof data === "object" ? Object.keys(data).join(", ") : typeof data;
    throw new Error(`Unexpected catalog payload shape (top-level keys: ${keys})`);
  }
  cached = { fetchedAt: Date.now(), buildId, extensions };
  return extensions;
}

export async function getExtensionCatalog(options: { force?: boolean } = {}): Promise<CatalogExtension[]> {
  const now = Date.now();
  if (!options.force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.extensions;
  }
  if (inflight) return inflight;
  inflight = loadFresh()
    .catch((err) => {
      // If a stale cache exists, return it rather than failing outright.
      if (cached) {
        console.warn(`[extension-catalog] refresh failed, using stale cache: ${err}`);
        return cached.extensions;
      }
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function getLastCatalogMeta() {
  return cached ? { fetchedAt: cached.fetchedAt, buildId: cached.buildId, count: cached.extensions.length } : null;
}
