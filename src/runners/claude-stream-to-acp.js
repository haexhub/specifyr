/**
 * Translate ONE Claude/Hermes stream-json event into ZERO or MORE ACP SessionUpdate objects.
 *
 * Stream-json shape (Claude CLI native, also synthesized by HermesStreamingRunner):
 *   { type: "assistant", message: { content: [{type: "text"|"tool_use", ...}, ...] } }
 *   { type: "user",      message: { content: [{type: "tool_result", ...}] } }
 *   { type: "system" | "result" | other }   ← no ACP analogue, ignored
 *
 * This is the SINGLE place provider-specific stream-json knowledge lives.
 * Old runners pipe their output through this on the way out so TurnBroker
 * never sees stream-json.
 *
 * @returns {Array<object>} zero or more SessionUpdate objects
 */
export function translateStreamEvent(event) {
  if (!event || typeof event !== "object") return [];

  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    const out = [];
    for (const block of event.message.content) {
      const update = blockToUpdate(block);
      if (update) out.push(update);
    }
    return out;
  }

  if (event.type === "user" && Array.isArray(event.message?.content)) {
    const out = [];
    for (const block of event.message.content) {
      if (block?.type === "tool_result") {
        out.push({
          sessionUpdate: "tool_call_update",
          toolCallId: block.tool_use_id,
          status: block.is_error ? "failed" : "completed",
          content: typeof block.content === "string"
            ? [{ type: "content", content: { type: "text", text: block.content } }]
            : undefined
        });
      }
    }
    return out;
  }

  return [];
}

function blockToUpdate(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") {
    return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } };
  }
  if (block.type === "tool_use") {
    return {
      sessionUpdate: "tool_call",
      toolCallId: block.id,
      title: block.name,
      kind: inferToolKind(block.name),
      status: "in_progress",
      rawInput: block.input
    };
  }
  return null;
}

function inferToolKind(name) {
  const n = String(name ?? "").toLowerCase();
  if (n === "read" || n.includes("read")) return "read";
  if (n === "edit" || n === "write" || n === "multiedit" || n.includes("write") || n.includes("edit")) return "edit";
  if (n === "bash" || n.includes("exec")) return "execute";
  if (n.includes("search") || n === "grep" || n === "glob") return "search";
  if (n.includes("fetch") || n.includes("http")) return "fetch";
  return "other";
}
