import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import fs from "node:fs/promises";
import { translateStreamEvent } from "./claude-stream-to-acp.js";

/**
 * Streaming runner for the `hermes` CLI.
 *
 * The exact hermes invocation is intentionally conservative: we call
 *   hermes chat -q
 * with the prompt on stdin and read stdout line-by-line. Each stdout line is
 * emitted as a synthetic `assistant` text event so the existing scheduler /
 * UI code that expects stream-json can consume it without changes.
 *
 * Per-project memory isolation: we set HERMES_HOME to the project-specific
 * `.hermes/memory` path when spawning, so hermes persists its state there
 * rather than in a global location.
 *
 * If the user's hermes binary supports a native `--memory-root` flag, we'd
 * prefer that — since that's binary-specific and we can't probe for it
 * universally, the HOME override is the safe, portable baseline.
 */
export class HermesStreamingRunner {
  static async isAvailable(binary = "hermes") {
    const path = await findBinaryInPath(binary);
    return Boolean(path);
  }

  constructor({ binary = "hermes", cwd = process.cwd(), memoryRoot, onEvent } = {}) {
    this.binary = binary;
    this.cwd = cwd;
    this.memoryRoot = memoryRoot;
    this.onEvent = onEvent;
    this.child = null;
  }

  async run({ prompt, signal } = {}) {
    if (!prompt?.trim()) {
      throw new Error("HermesStreamingRunner: prompt must be non-empty");
    }

    if (this.memoryRoot) {
      try {
        await fs.mkdir(this.memoryRoot, { recursive: true });
      } catch {
        /* best-effort */
      }
    }

    const env = {
      ...process.env,
      HERMES_HOME: this.memoryRoot ?? process.env.HERMES_HOME
    };

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["chat", "-q"], {
        cwd: this.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;

      let stdout = "";
      let stderr = "";
      let settled = false;
      let buffer = "";

      const emitText = (text) => {
        for (const update of translateStreamEvent({
          type: "assistant",
          message: { content: [{ type: "text", text }] }
        })) {
          try {
            this.onEvent?.(update);
          } catch {
            /* ignore consumer errors */
          }
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
        stdout += chunk;
        buffer += chunk;
        // Stream line-by-line so the UI gets incremental updates
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          emitText(`${line}\n`);
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
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

        // Flush any final partial line
        if (buffer) emitText(buffer);

        if (signal?.aborted) {
          reject(Object.assign(new Error("Aborted"), { aborted: true }));
          return;
        }
        if (code !== 0) {
          reject(
            Object.assign(
              new Error(`hermes exited with code ${code}: ${stderr.slice(0, 500)}`),
              { exitCode: code, stderr }
            )
          );
          return;
        }

        // Synthesize a result-shaped payload so callers that expect {result} work
        const resultText = stdout.trim();
        resolve({
          claudeSessionId: null,
          result: { type: "result", subtype: "success", result: resultText },
          exitCode: code,
          stderr
        });
      });

      const abortHandler = () => {
        if (this.child && !this.child.killed) this.child.kill("SIGTERM");
      };
      if (signal) {
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  cancel() {
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
  }
}

async function findBinaryInPath(name) {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/${name}${ext}`;
      try {
        await access(candidate);
        return candidate;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
