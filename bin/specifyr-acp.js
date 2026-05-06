#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createSpecifyrAcpAgent } from "../src/acp/server.js";

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);

new AgentSideConnection(
  (client) => createSpecifyrAcpAgent({ client, projectRoot: process.cwd() }),
  stream
);
