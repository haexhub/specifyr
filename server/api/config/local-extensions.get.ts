import { getAppConfigModule } from "#su/app-config";
import { enrichLocalExtension, type LocalExtensionMetadata } from "#su/local-extension";

export default defineEventHandler(async () => {
  const { loadAppConfig } = await getAppConfigModule();
  const cfg = await loadAppConfig();
  const entries = cfg.localExtensions ?? [];
  const enriched: LocalExtensionMetadata[] = await Promise.all(entries.map(enrichLocalExtension));
  return { extensions: enriched };
});
