import { spawn } from "node:child_process";

export function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        resolve({ ok: false, code: null, stdout, stderr: `Command not found: ${command}` });
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

/**
 * Spawn two commands and pipe stdout of the first to stdin of the second.
 * Returns the combined result (exit code of the second process).
 */
export function runPipeCommand(cmd1, args1, cmd2, args2, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(options.env ?? {}) };
    const cwd = options.cwd ?? process.cwd();
    const p1 = spawn(cmd1, args1, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const p2 = spawn(cmd2, args2, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    p1.stdout.pipe(p2.stdin);

    let stderr1 = "", stderr2 = "", stdout2 = "", p1Code = null;
    let stderrBuf = "";
    p1.stderr.on("data", (c) => {
      const chunk = c.toString();
      stderr1 += chunk;
      if (options.onLog) {
        stderrBuf += chunk;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) { if (line.trim()) options.onLog(line.trim()); }
      }
    });
    p2.stderr.on("data", (c) => { stderr2 += c.toString(); });
    p2.stdout.on("data", (c) => { stdout2 += c.toString(); });

    p1.on("error", reject);
    p2.on("error", reject);

    p1.on("close", (code) => {
      p1Code = code;
      if (code !== 0) p2.stdin.destroy();
      else p2.stdin.end();
    });

    p2.on("close", (code) => {
      const stderr = [stderr1, stderr2].filter(Boolean).join("\n");
      if (p1Code !== null && p1Code !== 0) {
        resolve({ ok: false, code: p1Code, stdout: stdout2, stderr });
      } else {
        resolve({ ok: code === 0, code, stdout: stdout2, stderr });
      }
    });
  });
}

export function spawnPassthrough(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}
