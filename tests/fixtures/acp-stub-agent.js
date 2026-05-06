#!/usr/bin/env node
// Run as: node tests/fixtures/acp-stub-agent.js [--script=<base64-json>]
//
// Speaks ACP over stdio. On every session/prompt request, replays the
// scripted sequence of session/update notifications, then resolves the
// prompt with the scripted stopReason (default "end_turn").
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const scriptArg = process.argv.find((a) => a.startsWith("--script="));
const script = scriptArg
  ? JSON.parse(
      Buffer.from(scriptArg.slice("--script=".length), "base64").toString("utf8"),
    )
  : {
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        },
      ],
      stopReason: "end_turn",
    };

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new AgentSideConnection(
  (client) => ({
    async initialize(params) {
      return {
        protocolVersion: params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            embeddedContext: false,
            image: false,
            audio: false,
          },
        },
      };
    },
    async newSession() {
      return { sessionId: "stub-session-1" };
    },
    async authenticate() {
      return null;
    },
    async prompt({ sessionId }) {
      for (const update of script.updates ?? []) {
        await client.sessionUpdate({ sessionId, update });
      }
      return { stopReason: script.stopReason ?? "end_turn" };
    },
    async cancel() {},
  }),
  stream,
);
