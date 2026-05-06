import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

export function makeFsHandlers({ cwd }) {
  if (!cwd || !path.isAbsolute(cwd)) {
    throw new Error("makeFsHandlers: absolute cwd required");
  }
  const root = path.resolve(cwd);

  function check(p) {
    if (typeof p !== "string" || p.length === 0) throw new Error("path required");
    if (!path.isAbsolute(p)) throw new Error("path must be absolute");
    const resolved = path.resolve(p);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path outside session cwd: ${resolved}`);
    }
    return resolved;
  }

  return {
    async readTextFile({ path: p, line, limit }) {
      const safe = check(p);
      const content = await readFile(safe, "utf8");
      if (line == null && limit == null) return { content };
      const lines = content.split("\n");
      const startIdx = Math.max(0, (line ?? 1) - 1);
      const sliced = limit != null ? lines.slice(startIdx, startIdx + limit) : lines.slice(startIdx);
      return { content: sliced.join("\n") };
    },
    async writeTextFile({ path: p, content }) {
      const safe = check(p);
      await mkdir(path.dirname(safe), { recursive: true });
      await writeFile(safe, content, "utf8");
      return {};
    }
  };
}
