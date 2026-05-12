/**
 * claude-oauth-driver: subprocess lifecycle for the OAuth login flow.
 *
 * Tests use a fake spawn function that returns a hand-crafted child
 * process emulator (EventEmitter + writable stdin + readable
 * stdout/stderr). No real `claude` binary is invoked.
 *
 * Real CLI output (claude-code 2.1.x):
 *   "Opening browser to sign in…
 *    If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
 *    Paste code here if prompted > "
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ClaudeOAuthDriver,
  readCredentialsExpiry,
} from "../../server/shared/utils/claude-oauth-driver.ts";

const FAKE_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&state=xyz";

class FakeChild extends EventEmitter {
  killed = false;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  stdinChunks: string[] = [];

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        this.stdinChunks.push(chunk.toString());
        cb();
      },
    });
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
  }

  emitStdout(s: string) {
    this.stdout.push(Buffer.from(s));
  }
  emitStderr(s: string) {
    this.stderr.push(Buffer.from(s));
  }
  emitClose(code: number) {
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("close", code);
  }
  kill(_signal?: string) {
    this.killed = true;
    this.emitClose(143);
    return true;
  }
}

function fakeSpawnFactory(child: FakeChild) {
  return ((..._args: unknown[]) => child as unknown) as never;
}

async function withTmpHome(body: (home: string) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-driver-"));
  try {
    await body(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("startLogin: parses URL from stdout and returns it", async () => {
  await withTmpHome(async (home) => {
    const child = new FakeChild();
    const driver = new ClaudeOAuthDriver({ spawnFn: fakeSpawnFactory(child) });
    const startPromise = driver.startLogin({ id: "flow-1", home });
    // Emit canned output asynchronously so the URL appears AFTER
    // startLogin has begun polling.
    setTimeout(() => {
      child.emitStdout(
        `Opening browser to sign in…\nIf the browser didn't open, visit: ${FAKE_URL}\nPaste code here if prompted > `,
      );
    }, 10);
    const r = await startPromise;
    assert.equal(r.url, FAKE_URL);
    // Driver creates $HOME/.claude/ ahead of the spawn so the CLI has
    // a place to write credentials.json.
    const stat = await fs.stat(path.join(home, ".claude"));
    assert.ok(stat.isDirectory());
    driver.cancel("flow-1");
  });
});

test("startLogin: rejects when CLI exits before printing URL", async () => {
  await withTmpHome(async (home) => {
    const child = new FakeChild();
    const driver = new ClaudeOAuthDriver({ spawnFn: fakeSpawnFactory(child) });
    const startPromise = driver.startLogin({ id: "flow-2", home });
    setTimeout(() => {
      child.emitStderr("login server unreachable\n");
      child.emitClose(1);
    }, 10);
    await assert.rejects(startPromise, /failed before printing URL|did not print a URL|exited/i);
    assert.equal(driver._activeIds().length, 0);
  });
});

test("startLogin: throws when an id is already active", async () => {
  await withTmpHome(async (home) => {
    const child = new FakeChild();
    const driver = new ClaudeOAuthDriver({ spawnFn: fakeSpawnFactory(child) });
    const p = driver.startLogin({ id: "dup", home });
    setTimeout(() => {
      child.emitStdout(`visit: ${FAKE_URL}`);
    }, 10);
    await p;
    await assert.rejects(
      driver.startLogin({ id: "dup", home }),
      /already active/,
    );
    driver.cancel("dup");
  });
});

test("submitCode: pipes code into stdin and resolves on clean exit", async () => {
  await withTmpHome(async (home) => {
    const child = new FakeChild();
    const driver = new ClaudeOAuthDriver({ spawnFn: fakeSpawnFactory(child) });
    const startPromise = driver.startLogin({ id: "flow-3", home });
    setTimeout(() => child.emitStdout(`visit: ${FAKE_URL}`), 10);
    await startPromise;

    const submitPromise = driver.submitCode("flow-3", "abc-123-xyz");
    setTimeout(() => child.emitClose(0), 20);
    await submitPromise;
    assert.deepEqual(child.stdinChunks, ["abc-123-xyz\n"]);
    assert.equal(driver._activeIds().length, 0);
  });
});

test("submitCode: rejects when CLI exits non-zero", async () => {
  await withTmpHome(async (home) => {
    const child = new FakeChild();
    const driver = new ClaudeOAuthDriver({ spawnFn: fakeSpawnFactory(child) });
    const startPromise = driver.startLogin({ id: "flow-4", home });
    setTimeout(() => child.emitStdout(`visit: ${FAKE_URL}`), 10);
    await startPromise;

    const p = driver.submitCode("flow-4", "wrong-code");
    setTimeout(() => {
      child.emitStderr("invalid code\n");
      child.emitClose(1);
    }, 20);
    await assert.rejects(p, /exited 1|invalid code/i);
  });
});

test("submitCode: throws on unknown flow id", async () => {
  const driver = new ClaudeOAuthDriver({
    spawnFn: fakeSpawnFactory(new FakeChild()),
  });
  await assert.rejects(driver.submitCode("never-existed", "x"), /no active flow/);
});

test("cancel: kills subprocess and removes flow", async () => {
  await withTmpHome(async (home) => {
    const child = new FakeChild();
    const driver = new ClaudeOAuthDriver({ spawnFn: fakeSpawnFactory(child) });
    const startPromise = driver.startLogin({ id: "flow-5", home });
    setTimeout(() => child.emitStdout(`visit: ${FAKE_URL}`), 10);
    await startPromise;
    driver.cancel("flow-5");
    assert.equal(child.killed, true);
    assert.equal(driver._activeIds().length, 0);
  });
});

test("cancel: idempotent for unknown id", () => {
  const driver = new ClaudeOAuthDriver({
    spawnFn: fakeSpawnFactory(new FakeChild()),
  });
  driver.cancel("nothing-here"); // should not throw
});

test("startLogin: hard-timeout kills the process eventually", async () => {
  await withTmpHome(async (home) => {
    const child = new FakeChild();
    const driver = new ClaudeOAuthDriver({
      spawnFn: fakeSpawnFactory(child),
      flowTimeoutMs: 30,
    });
    const startPromise = driver.startLogin({ id: "flow-6", home });
    setTimeout(() => child.emitStdout(`visit: ${FAKE_URL}`), 5);
    await startPromise;
    // Wait past the timeout — backstop should fire.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(child.killed, true);
    assert.equal(driver._activeIds().length, 0);
  });
});

// ───── readCredentialsExpiry ─────

test("readCredentialsExpiry: returns null when file is absent", async () => {
  await withTmpHome(async (home) => {
    assert.equal(await readCredentialsExpiry(home), null);
  });
});

test("readCredentialsExpiry: handles top-level expiresAt (numeric ms)", async () => {
  await withTmpHome(async (home) => {
    const target = path.join(home, ".claude", ".credentials.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const future = Date.now() + 60_000;
    await fs.writeFile(
      target,
      JSON.stringify({ accessToken: "x", expiresAt: future }),
    );
    const r = await readCredentialsExpiry(home);
    assert.ok(r);
    assert.equal(r.getTime(), future);
  });
});

test("readCredentialsExpiry: handles nested claudeAiOauth.expiresAt shape", async () => {
  await withTmpHome(async (home) => {
    const target = path.join(home, ".claude", ".credentials.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const future = Date.now() + 60_000;
    await fs.writeFile(
      target,
      JSON.stringify({
        claudeAiOauth: { accessToken: "x", expiresAt: future },
      }),
    );
    const r = await readCredentialsExpiry(home);
    assert.ok(r);
    assert.equal(r.getTime(), future);
  });
});

test("readCredentialsExpiry: handles ISO-string expires_at", async () => {
  await withTmpHome(async (home) => {
    const target = path.join(home, ".claude", ".credentials.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const iso = "2030-01-01T00:00:00.000Z";
    await fs.writeFile(target, JSON.stringify({ expires_at: iso }));
    const r = await readCredentialsExpiry(home);
    assert.equal(r?.toISOString(), iso);
  });
});

test("readCredentialsExpiry: returns null for malformed JSON", async () => {
  await withTmpHome(async (home) => {
    const target = path.join(home, ".claude", ".credentials.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "not json at all");
    assert.equal(await readCredentialsExpiry(home), null);
  });
});

// ───── readCredentialsState ─────

test("readCredentialsState: 'missing' when file is absent", async () => {
  const { readCredentialsState } = await import(
    "../../server/shared/utils/claude-oauth-driver.ts"
  );
  await withTmpHome(async (home) => {
    const r = await readCredentialsState(home);
    assert.equal(r.kind, "missing");
  });
});

test("readCredentialsState: 'present' with expiry when file is valid", async () => {
  const { readCredentialsState } = await import(
    "../../server/shared/utils/claude-oauth-driver.ts"
  );
  await withTmpHome(async (home) => {
    const target = path.join(home, ".claude", ".credentials.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const future = Date.now() + 60_000;
    await fs.writeFile(
      target,
      JSON.stringify({ accessToken: "x", expiresAt: future }),
    );
    const r = await readCredentialsState(home);
    assert.equal(r.kind, "present");
    assert.equal(
      r.kind === "present" ? r.expiresAt?.getTime() : null,
      future,
    );
  });
});

test("readCredentialsState: 'present' with null expiry for malformed JSON", async () => {
  const { readCredentialsState } = await import(
    "../../server/shared/utils/claude-oauth-driver.ts"
  );
  await withTmpHome(async (home) => {
    const target = path.join(home, ".claude", ".credentials.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "not json");
    const r = await readCredentialsState(home);
    assert.equal(r.kind, "present");
    assert.equal(r.kind === "present" ? r.expiresAt : "wrong", null);
  });
});
