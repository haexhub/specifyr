import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { encodeSessionId, decodeSessionId } from "./session-id.js";
import { AcpApprovalTransport } from "./approval-transport.js";

async function resolveSlugFromCwd(projectRoot, cwd) {
  const root = path.resolve(projectRoot);
  const dir = path.join(root, ".specifyr");
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { throw new Error(`no specifyr project at ${root}`); }
  const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (slugs.length === 0) throw new Error(`no specifyr project at ${root}`);
  const cwdResolved = path.resolve(cwd);
  const match = slugs.find((s) => cwdResolved.startsWith(path.join(dir, s)));
  if (match) return match;
  if (slugs.length === 1) return slugs[0];
  throw new Error(`ambiguous slug: cwd ${cwd} matches none of ${slugs.join(", ")}`);
}

export function createSpecifyrAcpAgent({ client, projectRoot, turnBroker, approvalService } = {}) {
  const approvalTransport = (approvalService && client) ? new AcpApprovalTransport({ client }) : null;
  if (approvalTransport && typeof approvalService.addTransport === "function") {
    approvalService.addTransport(approvalTransport);
  }
  return {
    async initialize() {
      return {
        protocolVersion: 1,
        agentInfo: { name: "specifyr", version: "0.1.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true, image: false, audio: false },
          mcpCapabilities: { http: false, sse: false }
        },
        authMethods: []
      };
    },
    async authenticate() { return null; },

    async newSession({ cwd }) {
      const slug = await resolveSlugFromCwd(projectRoot, cwd);
      const stepId = "ad-hoc";
      const sid = `acp-${randomUUID().slice(0, 8)}`;
      const stepsDir = path.join(projectRoot, ".specifyr", slug, "steps", stepId, "sessions");
      await fs.mkdir(stepsDir, { recursive: true });
      await fs.writeFile(
        path.join(stepsDir, `${sid}.json`),
        JSON.stringify(
          { id: sid, status: "idle", title: "ACP session", createdAt: new Date().toISOString() },
          null,
          2
        )
      );
      const sessionId = encodeSessionId({ slug, stepId, sid });
      approvalTransport?.bindSession({ slug, stepId, sid }, sessionId);
      return { sessionId };
    },

    async loadSession({ sessionId }) {
      const { slug, stepId, sid } = decodeSessionId(sessionId);
      const file = path.join(projectRoot, ".specifyr", slug, "steps", stepId, "sessions", `${sid}.json`);
      try { await fs.access(file); }
      catch { throw new Error(`session not found: ${sessionId}`); }
      return {};
    },

    async prompt({ sessionId, prompt }) {
      const { slug, stepId, sid } = decodeSessionId(sessionId);
      const text = prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const cwd = projectRoot;
      const emitter = turnBroker.emitterFor(slug, stepId, sid);
      let stopReason = "end_turn";

      const done = new Promise((resolve) => {
        const onEvent = async (entry) => {
          if (entry.event === "session_update") {
            try { await client.sessionUpdate({ sessionId, update: entry.data }); }
            catch { /* client gone — TurnBroker still persists */ }
          } else if (entry.event === "turn_failed") {
            stopReason = "refusal";
          }
        };
        const onEnded = () => {
          emitter.off("event", onEvent);
          emitter.off("ended", onEnded);
          resolve();
        };
        emitter.on("event", onEvent);
        emitter.on("ended", onEnded);
      });

      await turnBroker.startTurn({ slug, stepId, sid, prompt: text, cwd });
      await done;
      return { stopReason };
    },

    async cancel({ sessionId }) {
      const { slug, stepId, sid } = decodeSessionId(sessionId);
      turnBroker.cancel?.(slug, stepId, sid);
    }
  };
}
