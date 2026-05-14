import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { ensureDir, exists, readJson, readText, writeJson, writeText } from "../utils/fs.js";
import { SPECIFYR_DIR } from "./constants.js";

function titleFromPrompt(prompt, max = 60) {
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  if (!firstLine) {
    return "Neue Session";
  }
  if (firstLine.length <= max) {
    return firstLine;
  }
  return `${firstLine.slice(0, max - 1).trimEnd()}…`;
}

export class SessionStore {
  constructor(cwd = process.cwd()) {
    this.rootDir = path.join(cwd, SPECIFYR_DIR);
  }

  stepDir(orgId, slug, stepId) {
    return path.join(this.rootDir, orgId, slug, "steps", stepId);
  }

  sessionsDir(orgId, slug, stepId) {
    return path.join(this.stepDir(orgId, slug, stepId), "sessions");
  }

  metaPath(orgId, slug, stepId, sessionId) {
    return path.join(this.sessionsDir(orgId, slug, stepId), `${sessionId}.json`);
  }

  messagesPath(orgId, slug, stepId, sessionId) {
    return path.join(this.sessionsDir(orgId, slug, stepId), `${sessionId}.messages.jsonl`);
  }

  // Per-session append-only log of every event during turns (raw Claude events,
  // assistant_message, done, error). The disk file is the single source of truth — the
  // turn broker only keeps a notification emitter in memory, no event payloads.
  eventsPath(orgId, slug, stepId, sessionId) {
    return path.join(this.sessionsDir(orgId, slug, stepId), `${sessionId}.events.jsonl`);
  }

  async createSession(orgId, slug, stepId, { initialPrompt, title } = {}) {
    await ensureDir(this.sessionsDir(orgId, slug, stepId));
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const meta = {
      id: sessionId,
      stepId,
      title: title ?? titleFromPrompt(initialPrompt ?? "Neue Session"),
      status: "idle",
      claudeSessionId: null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0
    };
    await writeJson(this.metaPath(orgId, slug, stepId, sessionId), meta);
    await writeText(this.messagesPath(orgId, slug, stepId, sessionId), "");
    return meta;
  }

  async listSessions(orgId, slug, stepId) {
    const dir = this.sessionsDir(orgId, slug, stepId);
    if (!(await exists(dir))) {
      return [];
    }
    const entries = await fs.readdir(dir);
    const metas = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".messages.jsonl")) continue;
      const sessionId = entry.replace(/\.json$/, "");
      const meta = await readJson(this.metaPath(orgId, slug, stepId, sessionId), null);
      if (meta) {
        metas.push(meta);
      }
    }
    return metas.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
  }

  async getSession(orgId, slug, stepId, sessionId) {
    const meta = await readJson(this.metaPath(orgId, slug, stepId, sessionId), null);
    if (!meta) {
      return null;
    }
    const messages = await this.listMessages(orgId, slug, stepId, sessionId);
    return { ...meta, messages };
  }

  async getSessionMeta(orgId, slug, stepId, sessionId) {
    return readJson(this.metaPath(orgId, slug, stepId, sessionId), null);
  }

  async listMessages(orgId, slug, stepId, sessionId) {
    const content = await readText(this.messagesPath(orgId, slug, stepId, sessionId), "");
    if (!content) return [];
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  // Removes meta + messages + events for a session. Returns true if the meta
  // existed, false if it was already gone. The caller is responsible for
  // cancelling any running turn first — we don't reach into the broker here
  // because the store is also used outside Nitro (CLI, tests).
  async deleteSession(orgId, slug, stepId, sessionId) {
    const metaFile = this.metaPath(orgId, slug, stepId, sessionId);
    const existed = await exists(metaFile);
    await Promise.all([
      fs.rm(metaFile, { force: true }),
      fs.rm(this.messagesPath(orgId, slug, stepId, sessionId), { force: true }),
      fs.rm(this.eventsPath(orgId, slug, stepId, sessionId), { force: true }),
    ]);
    return existed;
  }

  async appendMessage(orgId, slug, stepId, sessionId, message) {
    const withId = { id: message.id ?? randomUUID(), createdAt: new Date().toISOString(), ...message };
    const line = `${JSON.stringify(withId)}\n`;
    const filePath = this.messagesPath(orgId, slug, stepId, sessionId);
    await ensureDir(path.dirname(filePath));
    const current = await readText(filePath, "");
    await writeText(filePath, `${current}${line}`);

    const meta = await this.getSessionMeta(orgId, slug, stepId, sessionId);
    if (meta) {
      meta.messageCount = (meta.messageCount ?? 0) + 1;
      meta.updatedAt = withId.createdAt;
      await writeJson(this.metaPath(orgId, slug, stepId, sessionId), meta);
    }
    return withId;
  }

  async updateSessionMeta(orgId, slug, stepId, sessionId, patch) {
    const meta = await this.getSessionMeta(orgId, slug, stepId, sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const updated = { ...meta, ...patch, updatedAt: new Date().toISOString() };
    await writeJson(this.metaPath(orgId, slug, stepId, sessionId), updated);
    return updated;
  }

  async setSessionStatus(orgId, slug, stepId, sessionId, status) {
    return this.updateSessionMeta(orgId, slug, stepId, sessionId, { status });
  }

  async setClaudeSessionId(orgId, slug, stepId, sessionId, claudeSessionId) {
    return this.updateSessionMeta(orgId, slug, stepId, sessionId, { claudeSessionId });
  }

  // Append a single turn event line. Caller is responsible for assigning a monotonic seq.
  // The broker owns the seq counter; this method just writes.
  async appendEvent(orgId, slug, stepId, sessionId, entry) {
    const filePath = this.eventsPath(orgId, slug, stepId, sessionId);
    await ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  // Last seq number on disk, or 0 for an empty/missing log.
  async getLastEventSeq(orgId, slug, stepId, sessionId) {
    const content = await readText(this.eventsPath(orgId, slug, stepId, sessionId), "");
    if (!content) return 0;
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) return 0;
    try {
      const last = JSON.parse(lines[lines.length - 1]);
      return typeof last.seq === "number" ? last.seq : 0;
    } catch {
      return 0;
    }
  }

  // All events with seq > sinceSeq, in order. Skips malformed lines silently — those
  // would be from a partial write that crashed mid-flush; the next valid event is what
  // matters for replay.
  async readEventsSince(orgId, slug, stepId, sessionId, sinceSeq) {
    const content = await readText(this.eventsPath(orgId, slug, stepId, sessionId), "");
    if (!content) return [];
    const out = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.seq === "number" && parsed.seq > sinceSeq) out.push(parsed);
      } catch {
        // ignore malformed
      }
    }
    return out;
  }

  // Walk every session under .specifyr/<orgId>/<slug>/steps/<*>/sessions/ and transition
  // any whose status was "running" at process death to "interrupted". Called once at server
  // start so the UI never sees a permanently-stuck "running" session after a crash/restart.
  async interruptRunningSessions() {
    if (!(await exists(this.rootDir))) return [];
    const interrupted = [];
    const orgIds = await fs.readdir(this.rootDir).catch(() => []);
    for (const orgId of orgIds) {
      const orgDir = path.join(this.rootDir, orgId);
      const slugs = await fs.readdir(orgDir).catch(() => []);
      for (const slug of slugs) {
        const stepsDir = path.join(orgDir, slug, "steps");
        const stepIds = await fs.readdir(stepsDir).catch(() => []);
        for (const stepId of stepIds) {
          const sessDir = path.join(stepsDir, stepId, "sessions");
          const files = await fs.readdir(sessDir).catch(() => []);
          for (const file of files) {
            // Only meta files: "<sid>.json" — skip messages/events JSONL siblings.
            if (!file.endsWith(".json") || file.endsWith(".jsonl")) continue;
            if (file.endsWith(".messages.jsonl") || file.endsWith(".events.jsonl")) continue;
            const metaPath = path.join(sessDir, file);
            const meta = await readJson(metaPath, null);
            if (meta?.status !== "running") continue;
            const sessionId = file.replace(/\.json$/, "");
            const updated = {
              ...meta,
              status: "interrupted",
              updatedAt: new Date().toISOString(),
              interruptedAt: new Date().toISOString(),
              interruptedReason: "server-restart"
            };
            await writeJson(metaPath, updated);
            interrupted.push({ orgId, slug, stepId, sessionId });
          }
        }
      }
    }
    return interrupted;
  }
}
