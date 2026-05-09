#!/usr/bin/env node
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createSpecifyrAcpAgent } from "../src/acp/server.js";
import { TurnBroker } from "../src/core/turn-broker.js";
import { SessionStore } from "../src/core/session-store.js";
import { AcpRunner } from "../src/runners/acp.js";
import { loadAppConfig } from "../src/core/app-config.js";
import { CapabilityApprovalService } from "../src/core/capability-approval-service.js";
import { EventStore } from "../src/core/event-store.js";

const projectRoot = process.cwd();
const appConfig = await loadAppConfig(projectRoot);
const sessionStore = new SessionStore(projectRoot);
const eventStore = new EventStore(path.join(projectRoot, ".specifyr"));
const approvalService = new CapabilityApprovalService({ eventStore });

function pickRunnerFactory() {
  for (const name of appConfig.runner.fallbackChain) {
    if (name.startsWith("acp:")) {
      const cfg = appConfig.acp?.[name.slice(4)];
      if (cfg?.binary) {
        return ({ cwd, onEvent }) =>
          new AcpRunner({ binary: cfg.binary, args: cfg.args, cwd, onEvent });
      }
    }
  }
  throw new Error("specifyr-acp: no ACP runner configured — check appConfig.runner.fallbackChain");
}

const turnBroker = new TurnBroker({ sessionStore, runnerFactory: pickRunnerFactory() });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);

new AgentSideConnection(
  (client) => createSpecifyrAcpAgent({ client, projectRoot, turnBroker, approvalService }),
  stream
);
