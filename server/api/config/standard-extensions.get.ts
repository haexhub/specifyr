import { getAppConfigModule } from "@su/app-config";

export default defineEventHandler(async () => {
  const { loadAppConfig } = await getAppConfigModule();
  const cfg = await loadAppConfig();
  return { extensions: cfg.standardExtensions };
});
