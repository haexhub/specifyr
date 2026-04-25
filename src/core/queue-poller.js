/**
 * QueuePoller — watches `.specops/<company>/queue/` for incoming task YAML
 * files and emits parsed task events.
 *
 * Built on chokidar (already a haex-corp dependency). One poller instance
 * per company. The CEO process subscribes; the runtime decides what to do
 * with the events.
 *
 * Events:
 *   - 'task'         { path, task }            new yaml file or content change
 *   - 'task-removed' { path }                  yaml file removed
 *   - 'error'        Error                     watcher or parse error
 */

import { EventEmitter } from "node:events";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { parse as parseYaml } from "yaml";

export class QueuePoller extends EventEmitter {
  constructor({ queueDir }) {
    super();
    if (!queueDir) throw new Error("QueuePoller: queueDir required");
    this.queueDir = queueDir;
    this.watcher = null;
  }

  async start() {
    await mkdir(this.queueDir, { recursive: true });
    // chokidar v5 dropped glob support — watch the directory and filter
    // non-yaml entries via the `ignored` callback.
    this.watcher = chokidar.watch(this.queueDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 0,
      ignored: (p) => p !== this.queueDir && !p.endsWith(".yaml"),
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });

    this.watcher.on("add", (file) => this.#handleFile(file));
    this.watcher.on("change", (file) => this.#handleFile(file));
    this.watcher.on("unlink", (file) => this.emit("task-removed", { path: file }));
    this.watcher.on("error", (err) => this.emit("error", err));

    // Wait for chokidar to be ready so initial pickups are flushed before we return.
    await new Promise((resolve) => this.watcher.once("ready", resolve));
  }

  async #handleFile(filePath) {
    try {
      const raw = await readFile(filePath, "utf8");
      const task = parseYaml(raw);
      this.emit("task", { path: filePath, task });
    } catch (err) {
      this.emit("error", new Error(`failed to parse ${path.basename(filePath)}: ${err.message}`));
    }
  }

  async stop() {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }
}
