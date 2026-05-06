#!/usr/bin/env node
// Pretend to be the `claude` CLI for tests:
// - Ignore all CLI args.
// - Read stdin (prompt) until EOF.
// - Emit a scripted sequence of stream-json events on stdout.
// - Exit 0.

const events = [
  { type: "system", subtype: "init", session_id: "stub-claude-1" },
  { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
  {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/x" } }] }
  },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: " world" }] } },
  { type: "result", subtype: "success", session_id: "stub-claude-1", result: "Hello world", is_error: false }
];

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdinBuf += c; });
process.stdin.on("end", () => {
  for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
  process.exit(0);
});
