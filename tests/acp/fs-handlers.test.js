import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFsHandlers } from "../../src/acp/fs-handlers.js";

async function tempProject() {
  const root = await mkdtemp(path.join(tmpdir(), "acp-fs-"));
  await writeFile(path.join(root, "hello.txt"), "world");
  return root;
}

test("read inside cwd", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  const r = await fs.readTextFile({ path: path.join(root, "hello.txt") });
  assert.equal(r.content, "world");
});

test("read rejects path outside cwd", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  await assert.rejects(fs.readTextFile({ path: "/etc/passwd" }), /outside/);
});

test("read rejects relative paths", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  await assert.rejects(fs.readTextFile({ path: "hello.txt" }), /absolute/);
});

test("write inside cwd creates file", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  await fs.writeTextFile({ path: path.join(root, "out.txt"), content: "data" });
  assert.equal(await readFile(path.join(root, "out.txt"), "utf8"), "data");
});

test("write rejects outside cwd", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  await assert.rejects(fs.writeTextFile({ path: "/tmp/escape", content: "x" }), /outside/);
});

test("read with line+limit slice", async () => {
  const root = await tempProject();
  const fs = makeFsHandlers({ cwd: root });
  const file = path.join(root, "multi.txt");
  await writeFile(file, "a\nb\nc\nd\ne\n");
  const r = await fs.readTextFile({ path: file, line: 2, limit: 2 });
  assert.equal(r.content, "b\nc");
});
