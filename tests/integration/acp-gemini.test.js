import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { AcpRunner } from "../../src/runners/acp.js";

function hasGemini() {
  try {
    execSync("gemini --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("gemini-cli end-to-end via ACP", { skip: !hasGemini() }, async () => {
  const events = [];
  const runner = new AcpRunner({
    binary: "gemini",
    args: ["--experimental-acp"],
    cwd: process.cwd(),
    onEvent: (e) => events.push(e)
  });
  const r = await runner.run({ prompt: "Reply with the single word OK and nothing else." });
  assert.equal(r.exitCode, 0);
  const text = events
    .filter((e) => e.sessionUpdate === "agent_message_chunk")
    .map((e) => e.content?.text ?? "")
    .join("");
  assert.match(text, /OK/i);
});
