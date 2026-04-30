import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir } from "./data-dirs";

export async function createOrchestrator() {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src/core/orchestrator.js")).href;
  const { SpecOrchestrator } = await import(moduleUrl);
  return new SpecOrchestrator({ cwd: dataDir() });
}
