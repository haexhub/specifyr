import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpecifyrAcpAgent } from "../../src/acp/server.js";
import { encodeSessionId } from "../../src/acp/session-id.js";

test("session/load returns ok for an existing session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  const slug = "demo", stepId = "step-1", sid = "s1";
  const dir = path.join(root, ".specifyr", slug, "steps", stepId, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${sid}.json`), JSON.stringify({ id: sid, status: "completed" }));
  const agent = createSpecifyrAcpAgent({ client: {}, projectRoot: root });
  const r = await agent.loadSession({
    sessionId: encodeSessionId({ slug, stepId, sid }), cwd: root, mcpServers: []
  });
  assert.deepEqual(r, {});
});

test("session/load on missing session rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specifyr-acp-"));
  const agent = createSpecifyrAcpAgent({ client: {}, projectRoot: root });
  await assert.rejects(
    agent.loadSession({ sessionId: encodeSessionId({ slug: "x", stepId: "y", sid: "z" }), cwd: root, mcpServers: [] }),
    /not found/i
  );
});
