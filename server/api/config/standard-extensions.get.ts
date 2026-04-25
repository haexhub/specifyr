import { getAppConfigModule } from "../../utils/app-config";

export default defineEventHandler(async () => {
  const { loadAppConfig } = await getAppConfigModule();
  const cfg = await loadAppConfig();
  return { extensions: cfg.standardExtensions };
});
