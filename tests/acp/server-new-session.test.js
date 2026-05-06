import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpecifyrAcpAgent } from "../../src/acp/server.js";

async function projectWithSlug(slug = "demo") {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  await mkdir(path.join(root, ".specifyr", slug, "steps"), { recursive: true });
  await writeFile(path.join(root, ".specifyr", slug, "meta.json"), JSON.stringify({ slug, title: "demo" }));
  return { root, slug };
}

test("session/new with cwd inside the only slug returns an encoded sessionId", async () => {
  const { root, slug } = await projectWithSlug();
  const agent = createSpecifyrAcpAgent({ client: { sessionUpdate: async () => {} }, projectRoot: root });
  const r = await agent.newSession({ cwd: root, mcpServers: [] });
  assert.match(r.sessionId, new RegExp(`^specifyr:1:${slug}:`));
});

test("session/new with cwd in unknown project rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  const agent = createSpecifyrAcpAgent({ client: {}, projectRoot: root });
  await assert.rejects(agent.newSession({ cwd: root, mcpServers: [] }), /no specifyr project/i);
});

test("session/new with cwd inside a multi-slug project picks the matching slug from the path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  await mkdir(path.join(root, ".specifyr", "alpha"), { recursive: true });
  await mkdir(path.join(root, ".specifyr", "beta"), { recursive: true });
  const agent = createSpecifyrAcpAgent({ client: {}, projectRoot: root });
  const r = await agent.newSession({ cwd: path.join(root, ".specifyr", "beta"), mcpServers: [] });
  assert.match(r.sessionId, /^specifyr:1:beta:/);
});

test("session/new with ambiguous cwd rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  await mkdir(path.join(root, ".specifyr", "alpha"), { recursive: true });
  await mkdir(path.join(root, ".specifyr", "beta"), { recursive: true });
  const agent = createSpecifyrAcpAgent({ client: {}, projectRoot: root });
  await assert.rejects(agent.newSession({ cwd: root, mcpServers: [] }), /ambiguous/i);
});
