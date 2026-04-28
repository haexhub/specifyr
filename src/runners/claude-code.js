import { spawn } from "node:child_process";

/**
 * Runs Claude Code headless (`claude -p`) with stream-json output.
 *
 * Events emitted (via onEvent callback) match Claude Code's stream-json schema:
 *   - {type:"system",subtype:"init",session_id,...}
 *   - {type:"assistant",message:{content:[...]}}
 *   - {type:"user",message:{content:[...]}}   (tool results)
 *   - {type:"result",subtype,result,session_id,total_cost_usd,...}
 *
 * Unknown event types are still forwarded so the UI can inspect/debug.
 */
export class ClaudeCodeRunner {
  constructor({ binary = "claude", cwd = process.cwd(), onEvent } = {}) {
    this.binary = binary;
    this.cwd = cwd;
    this.onEvent = onEvent;
    this.child = null;
  }

  /**
   * Runs one turn. If `resumeSessionId` is provided, resumes that Claude session.
   * @returns {Promise<{claudeSessionId: string|null, result: object|null, exitCode: number|null, stderr: string}>}
   */
  run({ prompt, resumeSessionId, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (!prompt || !prompt.trim()) {
        reject(new Error("ClaudeCodeRunner: prompt must be a non-empty string"));
        return;
      }

      // `acceptEdits` auto-approves Edit/Write/NotebookEdit. `--allowedTools Bash` adds
      // shell access so wizards can run scripts (e.g. `node validate.mjs`) within the
      // project directory without blocking on a TTY approval that never arrives in -p mode.
      const args = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowedTools", "Bash"
      ];
      if (resumeSessionId) {
        args.push("--resume", resumeSessionId);
      }

      const child = spawn(this.binary, args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let claudeSessionId = null;
      let resultEvent = null;
      let settled = false;

      const safeEmit = (event) => {
        try {
          this.onEvent?.(event);
        } catch (err) {
          // Never let consumer callback errors kill the run
          stderrBuffer += `\n[onEvent error] ${err instanceof Error ? err.message : String(err)}`;
        }
      };

      child.stdin.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
      }

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event;
          try {
            event = JSON.parse(trimmed);
          } catch {
            // malformed JSON line — surface as raw event for debugging
            safeEmit({ type: "raw", line: trimmed });
            continue;
          }
          if (event?.type === "system" && event.session_id && !claudeSessionId) {
            claudeSessionId = event.session_id;
          }
          if (event?.type === "result") {
            resultEvent = event;
            if (event.session_id && !claudeSessionId) {
              claudeSessionId = event.session_id;
            }
          }
          safeEmit(event);
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk;
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.on("close", (code) => {
        this.child = null;
        if (settled) return;
        settled = true;
        if (signal?.aborted) {
          reject(Object.assign(new Error("Aborted"), { aborted: true }));
          return;
        }
        if (code !== 0 && !resultEvent) {
          reject(
            Object.assign(new Error(`claude exited with code ${code}: ${stderrBuffer.slice(0, 500)}`), {
              exitCode: code,
              stderr: stderrBuffer
            })
          );
          return;
        }
        resolve({
          claudeSessionId,
          result: resultEvent,
          exitCode: code,
          stderr: stderrBuffer
        });
      });

      const abortHandler = () => {
        if (this.child && !this.child.killed) {
          this.child.kill("SIGTERM");
        }
      };
      if (signal) {
        if (signal.aborted) {
          abortHandler();
        } else {
          signal.addEventListener("abort", abortHandler, { once: true });
        }
      }
    });
  }

  cancel() {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }
}

/**
 * Extracts assistant text from a Claude Code event's message blocks.
 * Returns concatenated text; ignores tool_use blocks (which UIs render separately).
 */
export function extractAssistantText(event) {
  if (event?.type !== "assistant") return "";
  const blocks = event.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}
