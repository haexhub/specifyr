import path from "node:path";
import { readText, writeText } from "../utils/fs.js";

export class EventStore {
  constructor(baseDir) {
    this.filePath = path.join(baseDir, "events.jsonl");
  }

  async append(event) {
    const current = await readText(this.filePath, "");
    const line = `${JSON.stringify(event)}\n`;
    await writeText(this.filePath, `${current}${line}`);
  }

  async list() {
    const content = await readText(this.filePath, "");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}
