import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { QueuePoller } from "../src/core/queue-poller.js";

async function createTempQueue() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qp-"));
  return dir;
}

function once(emitter, event, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}' event`)), timeoutMs);
    emitter.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

test("emits 'task' when a yaml file is added", async (t) => {
  const queue = await createTempQueue();
  const poller = new QueuePoller({ queueDir: queue });
  t.after(() => poller.stop());
  await poller.start();

  const filePath = path.join(queue, "hello.yaml");
  const eventPromise = once(poller, "task");
  await fs.writeFile(filePath, 'goal: "say hi"\n');
  const evt = await eventPromise;
  assert.equal(evt.path, filePath);
  assert.equal(evt.task.goal, "say hi");
});

test("ignores non-yaml files", async (t) => {
  const queue = await createTempQueue();
  const poller = new QueuePoller({ queueDir: queue });
  t.after(() => poller.stop());
  await poller.start();

  let fired = false;
  poller.on("task", () => {
    fired = true;
  });

  await fs.writeFile(path.join(queue, "README.md"), "# nope\n");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fired, false);
});

test("picks up pre-existing yaml files at start", async (t) => {
  const queue = await createTempQueue();
  const filePath = path.join(queue, "preload.yaml");
  await fs.writeFile(filePath, 'goal: "preload"\n');

  const poller = new QueuePoller({ queueDir: queue });
  t.after(() => poller.stop());
  const eventPromise = once(poller, "task");
  await poller.start();
  const evt = await eventPromise;
  assert.equal(evt.task.goal, "preload");
});

test("stop() removes the watcher and stops emitting", async () => {
  const queue = await createTempQueue();
  const poller = new QueuePoller({ queueDir: queue });
  await poller.start();

  let fired = false;
  poller.on("task", () => {
    fired = true;
  });

  await poller.stop();

  await fs.writeFile(path.join(queue, "after-stop.yaml"), 'goal: "ignore me"\n');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fired, false);
});

test("emits 'task-removed' when a file is deleted", async (t) => {
  const queue = await createTempQueue();
  const filePath = path.join(queue, "transient.yaml");
  await fs.writeFile(filePath, 'goal: "transient"\n');

  const poller = new QueuePoller({ queueDir: queue });
  t.after(() => poller.stop());
  await poller.start();
  // wait for initial pickup to settle
  await new Promise((r) => setTimeout(r, 200));

  const removedPromise = once(poller, "task-removed");
  await fs.unlink(filePath);
  const evt = await removedPromise;
  assert.equal(evt.path, filePath);
});

test("getPendingCount tracks files added & removed", async (t) => {
  const queue = await createTempQueue();
  const poller = new QueuePoller({ queueDir: queue });
  t.after(() => poller.stop());
  await poller.start();
  assert.equal(poller.getPendingCount(), 0);

  await fs.writeFile(path.join(queue, "a.yaml"), 'goal: "a"\n');
  await once(poller, "task");
  assert.equal(poller.getPendingCount(), 1);

  await fs.writeFile(path.join(queue, "b.yaml"), 'goal: "b"\n');
  await once(poller, "task");
  assert.equal(poller.getPendingCount(), 2);

  await fs.unlink(path.join(queue, "a.yaml"));
  await once(poller, "task-removed");
  assert.equal(poller.getPendingCount(), 1);
});
