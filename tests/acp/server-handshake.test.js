import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "..", "bin", "specifyr-acp.js");

test("server responds to initialize with protocolVersion=1", async () => {
  const p = spawn("node", [BIN], { stdio: ["pipe", "pipe", "inherit"] });
  const req = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} }
  }) + "\n";
  p.stdin.write(req);
  const res = await new Promise((resolve, reject) => {
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (err) { reject(err); }
      }
    });
    setTimeout(() => reject(new Error(`timeout — buf=${JSON.stringify(buf)}`)), 5000);
  });
  p.kill();
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, 1);
  assert.equal(res.result.agentCapabilities.loadSession, true);
});
