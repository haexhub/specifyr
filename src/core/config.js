import path from "node:path";
import { DEFAULT_CONFIG, SPECIFYR_DIR } from "./constants.js";
import { readJson, writeJson } from "../utils/fs.js";

function mergeConfig(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return override ?? base;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      result[key] = mergeConfig(baseValue, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class ConfigStore {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.filePath = path.join(cwd, SPECIFYR_DIR, "config.json");
  }

  async load() {
    const existing = await readJson(this.filePath, null);
    return mergeConfig(DEFAULT_CONFIG, existing ?? {});
  }

  async save(config) {
    const merged = mergeConfig(DEFAULT_CONFIG, config);
    await writeJson(this.filePath, merged);
    return merged;
  }
}
