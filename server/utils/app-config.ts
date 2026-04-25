import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadModule<T = Record<string, unknown>>(rel: string): Promise<T> {
  const url = pathToFileURL(path.join(process.cwd(), rel)).href;
  return import(url) as Promise<T>;
}

export interface LocalExtensionEntry {
  slug: string;
  path: string;
  registeredAt: string;
}

export async function getAppConfigModule() {
  return loadModule<{
    loadAppConfig: (cwd?: string) => Promise<{
      standardExtensions: string[];
      localExtensions: LocalExtensionEntry[];
      runner: { default: string; fallbackChain: string[] };
      claude: { binary: string };
      hermes: { binary: string };
    }>;
    saveAppConfig: (next: unknown, cwd?: string) => Promise<unknown>;
    setStandardExtensions: (list: string[], cwd?: string) => Promise<string[]>;
    addLocalExtension: (
      entry: { slug: string; path: string; registeredAt?: string },
      cwd?: string
    ) => Promise<LocalExtensionEntry>;
    removeLocalExtension: (slug: string, cwd?: string) => Promise<{ slug: string }>;
    findLocalExtensionPath: (slug: string, cwd?: string) => Promise<string | null>;
  }>("src/core/app-config.js");
}
