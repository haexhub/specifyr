# Inkrement 10a — Event Log + Reporting-DAG Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Schaffe das Beobachtungs-Substrat für Supervision: DAG-validierte `reports_to`-Hierarchie, deklaratives `delivers_to`-Field für Workflow-Handoffs (cycles erlaubt), und ein append-only per-day JSONL Event Log, das alle Dispatch-Lifecycle-Events kanonisch festhält.

**Architecture:**
1. **Spec-Validierung** — pure function in `spec-loader.js`. DAG-Cycle-Detection nur auf `reports_to` (Hierarchie). Existenz-Check auf `reports_to` und `delivers_to`. `delivers_to`-Zykel sind erlaubt (Refinement-Loops).
2. **JSONL Event Log** — neue `CompanyEventLog`-Klasse, schreibt `<projectRoot>/.specops/<slug>/events/YYYY-MM-DD.jsonl` via `await fs.appendFile`. Bewusst getrennt von der bestehenden `EventStore` (die spec-kit's Run-Orchestrator dient).
3. **Lifecycle-Events** — `CompanyRuntime` emittiert `dispatch-started`, `dispatch-completed`, `dispatch-failed`, `dispatch-error` ins Event Log. Completion-Events enthalten `recipients: [ceo, ...delivers_to]` als denormalisiertes Feld, damit Log self-contained ist. Optional: `parent_task_id` wird durchgereicht von `dispatch.post.ts` falls gesetzt — macht Iterations-Ketten rekonstruierbar.
4. **Keine Auto-Tickets, kein Inbox.** Reports sind reine Events. Konsumenten (Supervisor in 10c, UI in 13) lesen das Log direkt.

**Tech Stack:** Node 22, ES modules, `node:fs/promises` (`appendFile`/`mkdir`), `yaml`, `node --test`.

---

## Final Decisions Locked-In (nach Brainstorming-Session 2026-04-27/28)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Zwei separate Graphen:** `reports_to` (Hierarchie, DAG-pflichtig) und `delivers_to` (Workflow-Handoff, Zykel erlaubt) | Refinement-Loops (z.B. analyst ⇄ pipeline_builder bei Trading-Strategie-Iteration) sind legitim und müssen ausdrückbar sein. Hierarchie und Workflow sind unterschiedliche Konzepte; DAG-Constraint gehört nur an die Hierarchie. |
| 2 | **`delivers_to` heißt nicht `also_notify`** | "Notify" suggeriert FYI-Symmetrie. Es ist aber eine asymmetrische Übergabe von Arbeitsgrundlage (A produziert, B baut darauf auf). Sprache prägt das Mental Model im Speckit-Prozess. |
| 3 | **Reports werden NICHT als Tickets in Queue-Dirs geschrieben.** Reports sind reine Events im JSONL Log. | Tickets würden Auto-Dispatch durch Pollers triggern → Risiko von Duplikat-Arbeit (CEO sieht "A fertig" und delegiert C, obwohl B die Folge schon macht). Events haben keine Side-Effects. |
| 4 | **`recipients: [ceo, ...delivers_to]` ist Feld auf `dispatch-completed`/`-failed`/`-error` Events**, nicht ein separater Event-Typ | Eine Tatsache = ein Event. CEO ist immer drin (außer Reporter IST CEO). |
| 5 | **Termination-Policy ist NICHT in 10a.** | Termination ist Speckit-Prozess-Sache: pro Projekt, pro Task individuell. Lebt im Task-YAML (`termination:` Block) und im Agent-Prompt. Supervisor (10c) liest sie aus dem Task-YAML als Safety-Net. |
| 6 | **`parent_task_id` ja, `iteration` nein.** | `parent_task_id` ist trivial einzubauen und nötig, damit 10c und UI Iterations-Ketten rekonstruieren können. Iteration-Count ist daraus ableitbar — keine Doppelung. |
| 7 | **Existing `EventStore` wird NICHT wiederverwendet.** | Verschiedene Konsumenten (spec-kit-run vs. company-runtime), verschiedene Rotation, verschiedene Read-Paths. Sauber trennen. |
| 8 | **UTC-Datumsrotation** | ISO-Timestamps sind ohnehin UTC; Maschinen-übergreifende Konsistenz. |
| 9 | **Append-Concurrency:** rely on POSIX append-atomicity für sub-PIPE_BUF Writes (~4 KB) | JSON-Events sind weit darunter. `session-store.js:145` nutzt das Pattern bereits. |

---

## Files Touched

| Path | Action | What |
|---|---|---|
| [src/agents/spec-loader.js](src/agents/spec-loader.js) | modify | `validateReportingDag()` — Existenz-Check beider Felder, Cycle-Detection nur auf `reports_to`. Wired into `loadCompany()`. Normalize `agent.delivers_to = []` default. |
| [tests/spec-loader.test.js](tests/spec-loader.test.js) | modify | Validator unit tests + cycle/no-cycle cases |
| [tests/fixtures/spec-loader/valid/agents/dev.md](tests/fixtures/spec-loader/valid/agents/dev.md) | modify | Add `delivers_to: []` field |
| [tests/fixtures/spec-loader/valid/agents/ceo.md](tests/fixtures/spec-loader/valid/agents/ceo.md) | modify | Add `delivers_to: []` field |
| [tests/fixtures/spec-loader/reports-cycle/](tests/fixtures/spec-loader/reports-cycle/) | create | Fixture mit reports_to-Zykel (sollte rejected werden) |
| [tests/fixtures/spec-loader/delivers-cycle/](tests/fixtures/spec-loader/delivers-cycle/) | create | Fixture mit delivers_to-Zykel (sollte AKZEPTIERT werden) |
| [src/core/company-event-log.js](src/core/company-event-log.js) | create | `CompanyEventLog` — per-day JSONL append-only |
| [tests/company-event-log.test.js](tests/company-event-log.test.js) | create | Unit tests |
| [src/core/company-runtime.js](src/core/company-runtime.js) | modify | Inject `eventLog`, emit lifecycle-events mit `recipients` und optional `parent_task_id` |
| [tests/company-runtime.test.js](tests/company-runtime.test.js) | modify | Integration-Tests für Event-Emission |
| [src/core/mcp-dispatch.js](src/core/mcp-dispatch.js) | modify | `validateDispatchBody` toleriert optional `task.parent_task_id`; `buildDispatchYaml` reicht es durch |
| [tests/mcp-dispatch.test.js](tests/mcp-dispatch.test.js) | modify | Test für parent_task_id pass-through |
| [docs/plans/2026-04-27-roadmap.md](docs/plans/2026-04-27-roadmap.md) | modify | 10a als done markieren; Sektion 10c (Supervisor) als nächste neue Position einfügen |
| Memory: `architecture_decisions.md` §1 | modify | Reformulieren: zwei Graphen, delivers_to cycle-fähig, Termination explizit nicht hier |

---

## Implementation Tasks

> **TDD:** jeder Task ist ein Red-Green-Commit-Zyklus.
> **Skills:** `@superpowers:test-driven-development`, `@superpowers:verification-before-completion`.

---

### Task 1: Validator scaffold + delivers_to normalisation

**Files:** `src/agents/spec-loader.js`, `tests/spec-loader.test.js`

**Step 1: Failing test**

```javascript
import { validateReportingDag } from "../src/agents/spec-loader.js";

test("validateReportingDag: linear hierarchy passes", () => {
  const agents = new Map([
    ["ceo", { role: "ceo", reports_to: null, delivers_to: [] }],
    ["dev", { role: "dev", reports_to: "ceo", delivers_to: [] }],
  ]);
  validateReportingDag(agents);
});

test("loadAgents normalises missing delivers_to to []", async () => {
  const agents = await loadAgents(fixture);
  for (const a of agents.values()) {
    assert.ok(Array.isArray(a.delivers_to), `agent ${a.role}.delivers_to must be array`);
  }
});
```

**Step 2:** Run → FAIL (`validateReportingDag` not exported; `delivers_to` missing).

**Step 3:** In `src/agents/spec-loader.js`:

1. Add normalisation in `loadAgents` next to existing `fm.capabilities = ...`:
   ```javascript
   fm.delivers_to = Array.isArray(fm.delivers_to) ? fm.delivers_to : [];
   ```
2. Add stub:
   ```javascript
   /**
    * Validate the reporting + delivery graph.
    *
    * - reports_to: hierarchy edges. Must form a DAG (cycles → error).
    * - delivers_to: workflow-handoff metadata. Cycles ARE allowed
    *   (refinement loops, e.g. analyst ⇄ pipeline_builder).
    *
    * Both fields must reference known roles (typo guard).
    *
    * Throws:
    *   E_UNKNOWN_REPORTS_TO   — reports_to references unknown role
    *   E_UNKNOWN_DELIVERS_TO  — delivers_to[i] references unknown role
    *   E_REPORTS_TO_CYCLE     — reports_to chain has a cycle
    *
    * @param {Map<string, AgentSpec>} agents
    */
   export function validateReportingDag(agents) {
     // Filled in by following tasks.
   }
   ```

**Step 4:** Run → PASS.

**Step 5:** Commit
```bash
git commit -am "feat(spec-loader): scaffold validateReportingDag + normalise delivers_to"
```

---

### Task 2: reports_to existence check

**Step 1:** Failing test

```javascript
test("validateReportingDag: rejects unknown reports_to", () => {
  const agents = new Map([
    ["dev", { role: "dev", reports_to: "ghost", delivers_to: [] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_UNKNOWN_REPORTS_TO.*dev.*ghost/);
});
```

**Step 2:** Run → FAIL.

**Step 3:** Implementation:

```javascript
for (const [role, agent] of agents) {
  if (agent.reports_to != null && !agents.has(agent.reports_to)) {
    throw new Error(
      `E_UNKNOWN_REPORTS_TO: agent '${role}' reports_to '${agent.reports_to}' which is not a known role`
    );
  }
}
```

**Step 4:** Run → PASS.

**Step 5:**
```bash
git commit -am "feat(spec-loader): validate reports_to references known role"
```

---

### Task 3: delivers_to existence check

**Step 1:** Failing test

```javascript
test("validateReportingDag: rejects unknown delivers_to", () => {
  const agents = new Map([
    ["ceo", { role: "ceo", reports_to: null, delivers_to: [] }],
    ["dev", { role: "dev", reports_to: "ceo", delivers_to: ["ghost"] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_UNKNOWN_DELIVERS_TO.*dev.*ghost/);
});
```

**Step 2:** Run → FAIL.

**Step 3:** Add inside the existing loop:

```javascript
for (const peer of agent.delivers_to ?? []) {
  if (!agents.has(peer)) {
    throw new Error(
      `E_UNKNOWN_DELIVERS_TO: agent '${role}' delivers_to '${peer}' which is not a known role`
    );
  }
}
```

**Step 4:** Run → PASS.

**Step 5:**
```bash
git commit -am "feat(spec-loader): validate delivers_to references known role"
```

---

### Task 4: reports_to cycle detection

**Step 1:** Failing tests

```javascript
test("validateReportingDag: rejects 2-node reports_to cycle", () => {
  const agents = new Map([
    ["a", { role: "a", reports_to: "b", delivers_to: [] }],
    ["b", { role: "b", reports_to: "a", delivers_to: [] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_REPORTS_TO_CYCLE/);
});

test("validateReportingDag: rejects 3-node reports_to cycle", () => {
  const agents = new Map([
    ["a", { role: "a", reports_to: "b", delivers_to: [] }],
    ["b", { role: "b", reports_to: "c", delivers_to: [] }],
    ["c", { role: "c", reports_to: "a", delivers_to: [] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_REPORTS_TO_CYCLE/);
});

test("validateReportingDag: rejects self-loop reports_to", () => {
  const agents = new Map([
    ["a", { role: "a", reports_to: "a", delivers_to: [] }],
  ]);
  assert.throws(() => validateReportingDag(agents), /E_REPORTS_TO_CYCLE/);
});
```

**Step 2:** Run → FAIL.

**Step 3:** Implementation. Append after existence check:

```javascript
// Cycle detection on reports_to chain. Each node has 0 or 1 outgoing edge,
// so we just walk the chain and watch for revisits. Mark proven-acyclic
// nodes "settled" so subsequent walks short-circuit — keeps it linear.
const settled = new Set();
for (const start of agents.keys()) {
  if (settled.has(start)) continue;
  const onPath = new Set();
  const chain = [];
  let current = start;
  while (current != null && !settled.has(current)) {
    if (onPath.has(current)) {
      const idx = chain.indexOf(current);
      const cycle = [...chain.slice(idx), current].join(" → ");
      throw new Error(`E_REPORTS_TO_CYCLE: ${cycle}`);
    }
    onPath.add(current);
    chain.push(current);
    current = agents.get(current).reports_to;
  }
  for (const n of onPath) settled.add(n);
}
```

**Step 4:** Run → PASS.

**Step 5:**
```bash
git commit -am "feat(spec-loader): detect cycles in reports_to hierarchy"
```

---

### Task 5: delivers_to cycles are TOLERATED (the iteration-loop case)

**Step 1:** Test that asserts the relaxation

```javascript
test("validateReportingDag: tolerates delivers_to cycles (refinement loops)", () => {
  // Trading-Workflow-Beispiel: pipeline_builder ⇄ analyst Refinement-Loop.
  // Reports-Hierarchie ist dennoch ein Baum (alle reporten an ceo).
  const agents = new Map([
    ["ceo",              { role: "ceo",              reports_to: null,  delivers_to: [] }],
    ["pipeline_builder", { role: "pipeline_builder", reports_to: "ceo", delivers_to: ["analyst"] }],
    ["analyst",          { role: "analyst",          reports_to: "ceo", delivers_to: ["pipeline_builder"] }],
  ]);
  validateReportingDag(agents); // muss NICHT werfen
});

test("validateReportingDag: tolerates delivers_to self-loop", () => {
  const agents = new Map([
    ["ceo", { role: "ceo", reports_to: null,  delivers_to: [] }],
    ["dev", { role: "dev", reports_to: "ceo", delivers_to: ["dev"] }],
  ]);
  validateReportingDag(agents); // bizarr aber erlaubt — kein Hierarchie-Bruch
});
```

**Step 2:** Run → muss bereits PASSEN, weil Cycle-Detection nur `reports_to` betrachtet. Falls FAIL → Bug, fixen bevor weiter.

**Step 5:**
```bash
git commit -am "test(spec-loader): assert delivers_to cycles are tolerated"
```

---

### Task 6: Wire into loadCompany + Fixtures aktualisieren

**Files:**
- Modify: `src/agents/spec-loader.js` — wire `validateReportingDag` into `loadCompany`
- Modify: `tests/fixtures/spec-loader/valid/agents/{ceo,dev}.md` — `delivers_to: []` ergänzen
- Create: `tests/fixtures/spec-loader/reports-cycle/{constitution.md,agents/{a,b}.md}` — reports_to-Cycle
- Create: `tests/fixtures/spec-loader/delivers-cycle/{constitution.md,agents/{ceo,a,b}.md}` — delivers_to-Cycle (legitim)

**Step 1:** Failing tests

```javascript
test("loadCompany: rejects org with reports_to cycle", async () => {
  const dir = path.join(__dirname, "fixtures", "spec-loader", "reports-cycle");
  await assert.rejects(() => loadCompany(dir), /E_REPORTS_TO_CYCLE/);
});

test("loadCompany: ACCEPTS org with delivers_to cycle (refinement loop)", async () => {
  const dir = path.join(__dirname, "fixtures", "spec-loader", "delivers-cycle");
  const company = await loadCompany(dir);
  assert.equal(company.agents.size, 3);
});
```

**Step 2:** Fixtures anlegen.

`tests/fixtures/spec-loader/reports-cycle/constitution.md`:
```markdown
---
schema_version: "1.0"
company_id: "rc"
operating_mode: "finite"
budget: { max_usd_per_task: 1.0 }
---
```

`tests/fixtures/spec-loader/reports-cycle/agents/a.md`:
```markdown
---
schema_version: "1.0"
role: a
reports_to: b
delivers_to: []
tools: { builtin: [], mcp: [] }
capabilities: []
status: active
---
# A
```

`tests/fixtures/spec-loader/reports-cycle/agents/b.md`:
```markdown
---
schema_version: "1.0"
role: b
reports_to: a
delivers_to: []
tools: { builtin: [], mcp: [] }
capabilities: []
status: active
---
# B
```

`tests/fixtures/spec-loader/delivers-cycle/constitution.md`:
```markdown
---
schema_version: "1.0"
company_id: "dc"
operating_mode: "finite"
budget: { max_usd_per_task: 1.0 }
---
```

`tests/fixtures/spec-loader/delivers-cycle/agents/ceo.md`:
```markdown
---
schema_version: "1.0"
role: ceo
reports_to: null
delivers_to: []
tools: { builtin: [], mcp: [] }
capabilities: []
status: active
---
# CEO
```

`tests/fixtures/spec-loader/delivers-cycle/agents/a.md`:
```markdown
---
schema_version: "1.0"
role: a
reports_to: ceo
delivers_to: [b]
tools: { builtin: [], mcp: [] }
capabilities: []
status: active
---
# A
```

`tests/fixtures/spec-loader/delivers-cycle/agents/b.md`:
```markdown
---
schema_version: "1.0"
role: b
reports_to: ceo
delivers_to: [a]
tools: { builtin: [], mcp: [] }
capabilities: []
status: active
---
# B
```

**Step 3:** Existing fixtures ergänzen — `delivers_to: []` in `tests/fixtures/spec-loader/valid/agents/{ceo,dev}.md` (zwischen `capabilities` und `status`). Auch `retired-bot.md`.

Wire into loadCompany:
```javascript
export async function loadCompany(orgDir, options) {
  const [constitution, agents] = await Promise.all([
    loadConstitution(orgDir),
    loadAgents(orgDir, options),
  ]);
  validateReportingDag(agents);
  return { constitution, agents };
}
```

**Step 4:** Run all spec-loader tests → PASS.

**Step 5:**
```bash
git add src/agents/spec-loader.js tests/spec-loader.test.js tests/fixtures/spec-loader
git commit -m "feat(spec-loader): enforce DAG on reports_to, allow delivers_to cycles"
```

---

### Task 7: CompanyEventLog — Single append + per-day path

**Files:** `src/core/company-event-log.js`, `tests/company-event-log.test.js`

**Step 1:** Failing test

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CompanyEventLog } from "../src/core/company-event-log.js";

async function withTempDir(fn) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "cel-"));
  try { await fn(d); } finally { await fs.rm(d, { recursive: true, force: true }); }
}

test("CompanyEventLog.append writes JSONL line into events/YYYY-MM-DD.jsonl (UTC)", async () => {
  await withTempDir(async (root) => {
    const log = new CompanyEventLog({
      baseDir: root,
      clock: () => new Date("2026-04-28T10:30:00.000Z"),
    });
    const result = await log.append({ type: "dispatch-started", role: "ceo" });

    assert.match(result.id, /^[0-9a-f-]{36}$/);
    assert.equal(result.at, "2026-04-28T10:30:00.000Z");
    assert.equal(result.file, path.join(root, "events", "2026-04-28.jsonl"));

    const content = await fs.readFile(result.file, "utf8");
    const evt = JSON.parse(content.trim());
    assert.equal(evt.type, "dispatch-started");
    assert.equal(evt.role, "ceo");
    assert.equal(evt.at, "2026-04-28T10:30:00.000Z");
  });
});
```

**Step 2:** Run → FAIL.

**Step 3:** `src/core/company-event-log.js`:

```javascript
/**
 * CompanyEventLog — append-only per-day JSONL log of company-runtime events.
 *
 * Path layout: <baseDir>/events/YYYY-MM-DD.jsonl   (UTC date)
 *
 * Distinct from spec-kit's `EventStore` (src/core/event-store.js): different
 * concern (company-runtime vs run-orchestrator), different rotation, different
 * read-paths. Keep them separate.
 *
 * Events here are pure facts with no side-effect. The Supervisor (Inkrement
 * 10c) and the UI (Inkrement 13) read this log; nothing in 10a auto-acts on
 * an event.
 *
 * Append-atomicity: relies on POSIX atomic appends for sub-PIPE_BUF (~4 KB)
 * writes. JSON-encoded events are well below that boundary; no in-process
 * lock needed. (Same pattern as session-store.js:145.)
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class CompanyEventLog {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir
   * @param {() => Date} [opts.clock]    injectable for tests
   * @param {() => string} [opts.idFn]   injectable for tests
   */
  constructor({ baseDir, clock = () => new Date(), idFn = randomUUID }) {
    if (!baseDir) throw new Error("CompanyEventLog: baseDir required");
    this.baseDir = baseDir;
    this.clock = clock;
    this.idFn = idFn;
  }

  /**
   * @param {object} event   serialisable; should include `type`
   * @returns {Promise<{id: string, at: string, file: string}>}
   */
  async append(event) {
    const at = this.clock().toISOString();
    const day = at.slice(0, 10);
    const id = this.idFn();
    const enriched = { id, at, ...event };
    const file = path.join(this.baseDir, "events", `${day}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(enriched)}\n`, "utf8");
    return { id, at, file };
  }
}
```

**Step 4:** Run → PASS.

**Step 5:**
```bash
git add src/core/company-event-log.js tests/company-event-log.test.js
git commit -m "feat(company-event-log): per-day JSONL append-only event log"
```

---

### Task 8: CompanyEventLog — multi-append + day-rollover

**Step 1:** Tests

```javascript
test("CompanyEventLog: multiple events on same day go to one file in order", async () => {
  await withTempDir(async (root) => {
    const log = new CompanyEventLog({
      baseDir: root,
      clock: () => new Date("2026-04-28T10:30:00.000Z"),
    });
    await log.append({ type: "a" });
    await log.append({ type: "b" });
    await log.append({ type: "c" });
    const content = await fs.readFile(path.join(root, "events", "2026-04-28.jsonl"), "utf8");
    const types = content.trim().split("\n").map((l) => JSON.parse(l).type);
    assert.deepEqual(types, ["a", "b", "c"]);
  });
});

test("CompanyEventLog: rolls to a new file when UTC date changes", async () => {
  await withTempDir(async (root) => {
    let now = new Date("2026-04-28T23:59:00.000Z");
    const log = new CompanyEventLog({ baseDir: root, clock: () => now });
    await log.append({ type: "late" });
    now = new Date("2026-04-29T00:00:30.000Z");
    await log.append({ type: "early" });

    const d28 = await fs.readFile(path.join(root, "events", "2026-04-28.jsonl"), "utf8");
    const d29 = await fs.readFile(path.join(root, "events", "2026-04-29.jsonl"), "utf8");
    assert.equal(JSON.parse(d28.trim()).type, "late");
    assert.equal(JSON.parse(d29.trim()).type, "early");
  });
});
```

**Step 2:** Run → sollte PASSEN (Task 7 deckt das schon ab).

**Step 5:**
```bash
git commit -am "test(company-event-log): multi-append + date-rollover coverage"
```

---

### Task 9: mcp-dispatch — `parent_task_id` durchreichen

**Files:** `src/core/mcp-dispatch.js`, `tests/mcp-dispatch.test.js`

**Step 1:** Failing test

```javascript
test("buildDispatchYaml: passes through parent_task_id when provided", () => {
  const yaml = buildDispatchYaml({ goal: "x", parent_task_id: "t-001" }, "agent:ceo");
  const parsed = parseYaml(yaml);
  assert.equal(parsed.parent_task_id, "t-001");
  assert.equal(parsed.source, "agent:ceo");
});

test("buildDispatchYaml: omits parent_task_id when not provided", () => {
  const yaml = buildDispatchYaml({ goal: "y" }, "user");
  const parsed = parseYaml(yaml);
  assert.equal(parsed.parent_task_id, undefined);
});
```

**Step 2:** Run → sollte bereits PASSEN, weil `buildDispatchYaml` `task` per spread durchreicht. Falls test fehlschlägt: parsing ist hier wichtig — sicherstellen, dass `import { parse as parseYaml } from "yaml";` im Test-File ist.

**Step 3:** Wenn Test passt: nichts zu tun. Wenn nicht: vermutlich liefert `stringifyYaml` `null` für undefined-Felder, was OK ist.

**Step 5:**
```bash
git commit -am "test(mcp-dispatch): assert parent_task_id pass-through in dispatch yaml"
```

---

### Task 10: CompanyRuntime — accept `eventLog`, emit lifecycle events

**Files:** `src/core/company-runtime.js`, `tests/company-runtime.test.js`

**Step 1:** Failing test

```javascript
test("dispatch lifecycle: appends dispatch-started + dispatch-completed events with recipients", async () => {
  await withTempProject(async ({ proj, queue, queueDirs }) => {
    const captured = [];
    const stubLog = { async append(evt) { captured.push(evt); return { id: "x", at: "y", file: "z" }; } };

    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDirs,
      slug: "demo",
      runnerFactory: recordingRunnerFactory([]),
      eventLog: stubLog,
    });
    await runtime.start();

    const dispatched = new Promise((resolve) => runtime.once("dispatched", resolve));
    await fs.writeFile(path.join(queue, "ping.yaml"), 'goal: "ping"\n');
    await dispatched;
    await new Promise((r) => setTimeout(r, 50));

    const types = captured.map((e) => e.type);
    assert.ok(types.includes("dispatch-started"), `expected dispatch-started, got ${types.join(",")}`);
    assert.ok(types.includes("dispatch-completed"), `expected dispatch-completed, got ${types.join(",")}`);

    const completed = captured.find((e) => e.type === "dispatch-completed");
    assert.equal(completed.role, "ceo");
    // CEO ist Reporter → kein CEO-Self in recipients; CEO hat zudem keine delivers_to
    assert.deepEqual(completed.recipients, []);
    assert.equal(completed.status, "completed");

    await runtime.stop();
  });
});

test("dispatch from non-ceo: recipients includes ceo + delivers_to", async () => {
  // Org mit dev.delivers_to: [qa] anlegen, dispatch dev → completion
  // recipients sollte ["ceo", "qa"] sein
  // ... (test-impl analog zum vorigen, mit angepasster Spec)
});
```

**Step 2:** Run → FAIL (`eventLog` ctor-arg fehlt; Recipients-Logik fehlt).

**Step 3:** Implementation in `src/core/company-runtime.js`:

1. Import:
```javascript
import { CompanyEventLog } from "./company-event-log.js";
```

2. Ctor — add `eventLog` zum Destructure und initialisieren:
```javascript
constructor({
  // ... existing args
  eventLog,
} = {}) {
  // ... existing body
  this.eventLog = eventLog ?? new CompanyEventLog({
    baseDir: path.join(projectRoot, ".specops", this.slug),
  });
}
```

3. Helper-Method (private):
```javascript
_recipientsFor(reporterRole) {
  const reporter = this.company?.agents.get(reporterRole);
  if (!reporter) return [];
  const list = [];
  if (reporterRole !== this.ceoRole) list.push(this.ceoRole);
  for (const peer of reporter.delivers_to ?? []) {
    if (peer === reporterRole) continue;        // Self-Loop tolerieren, aber nicht in recipients
    if (list.includes(peer)) continue;          // dedupe
    list.push(peer);
  }
  return list;
}
```

4. In `_dispatchToRole` ersetze
   ```javascript
   this.emit("dispatch-started", { path: evt.path, role, workItem });
   const result = await runner.execute(workItem, runtimeContext);
   this.emit("dispatched", { path: evt.path, role, result });
   ```
   durch
   ```javascript
   this.emit("dispatch-started", { path: evt.path, role, workItem });
   await this.eventLog.append({
     type: "dispatch-started",
     slug: this.slug,
     role,
     task_path: evt.path,
     task_title: workItem.title,
     parent_task_id: evt.task?.parent_task_id ?? null,
   });

   let result;
   try {
     result = await runner.execute(workItem, runtimeContext);
   } catch (err) {
     await this.eventLog.append({
       type: "dispatch-error",
       slug: this.slug,
       role,
       task_path: evt.path,
       parent_task_id: evt.task?.parent_task_id ?? null,
       recipients: this._recipientsFor(role),
       error: err?.message ?? String(err),
     });
     throw err;
   }

   this.emit("dispatched", { path: evt.path, role, result });
   await this.eventLog.append({
     type: result?.status === "completed" ? "dispatch-completed" : "dispatch-failed",
     slug: this.slug,
     role,
     task_path: evt.path,
     task_title: workItem.title,
     parent_task_id: evt.task?.parent_task_id ?? null,
     recipients: this._recipientsFor(role),
     status: result?.status ?? "unknown",
     outputs: Array.isArray(result?.outputs) ? result.outputs : [],
   });
   ```

**Step 4:** Run → PASS.

**Step 5:**
```bash
git commit -am "feat(company-runtime): emit lifecycle events with recipients + parent_task_id"
```

---

### Task 11: CompanyRuntime — `parent_task_id` end-to-end-Test

**Step 1:** Test

```javascript
test("dispatch lifecycle: parent_task_id from task YAML appears in events", async () => {
  await withTempProject(async ({ proj, queue, queueDirs }) => {
    const captured = [];
    const stubLog = { async append(evt) { captured.push(evt); return { id: "x", at: "y", file: "z" }; } };
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDirs,
      slug: "demo",
      runnerFactory: recordingRunnerFactory([]),
      eventLog: stubLog,
    });
    await runtime.start();

    const dispatched = new Promise((resolve) => runtime.once("dispatched", resolve));
    await fs.writeFile(path.join(queue, "child.yaml"), 'goal: "iter"\nparent_task_id: "t-root"\n');
    await dispatched;
    await new Promise((r) => setTimeout(r, 50));

    for (const evt of captured) {
      assert.equal(evt.parent_task_id, "t-root", `event ${evt.type} should carry parent_task_id`);
    }

    await runtime.stop();
  });
});
```

**Step 2:** Run → sollte PASSEN durch Task 10.

**Step 5:**
```bash
git commit -am "test(company-runtime): parent_task_id flows from task yaml to events"
```

---

### Task 12: dispatch-failed Test

**Step 1:** Test

```javascript
test("dispatch lifecycle: failed status produces dispatch-failed event with recipients", async () => {
  await withTempProject(async ({ proj, queueDev, queueDirs }) => {
    const captured = [];
    const stubLog = { async append(evt) { captured.push(evt); return { id: "x", at: "y", file: "z" }; } };
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDirs,
      slug: "demo",
      runnerFactory: () => ({ async execute() { return { status: "failed", outputs: [] }; } }),
      eventLog: stubLog,
    });
    await runtime.start();

    const dispatched = new Promise((resolve) => runtime.once("dispatched", resolve));
    await fs.writeFile(path.join(queueDev, "doomed.yaml"), 'goal: "fail"\n');
    await dispatched;
    await new Promise((r) => setTimeout(r, 50));

    const failed = captured.find((e) => e.type === "dispatch-failed");
    assert.ok(failed, "expected a dispatch-failed event");
    assert.equal(failed.role, "dev");
    assert.equal(failed.status, "failed");
    // dev reporter → recipients [ceo] (dev's delivers_to is [] in the valid fixture)
    assert.deepEqual(failed.recipients, ["ceo"]);

    await runtime.stop();
  });
});
```

**Step 2:** Run → sollte PASSEN.

**Step 5:**
```bash
git commit -am "test(company-runtime): dispatch-failed event carries recipients"
```

---

### Task 13: dispatch-error Test (thrown error)

**Step 1:** Test

```javascript
test("dispatch lifecycle: thrown runner error produces dispatch-error event", async () => {
  await withTempProject(async ({ proj, queue, queueDirs }) => {
    const captured = [];
    const stubLog = { async append(evt) { captured.push(evt); return { id: "x", at: "y", file: "z" }; } };
    const runtime = new CompanyRuntime({
      projectRoot: proj,
      orgDir: validFixture,
      queueDirs,
      slug: "demo",
      runnerFactory: () => ({ async execute() { throw new Error("boom"); } }),
      eventLog: stubLog,
    });
    await runtime.start();

    const errorPromise = new Promise((resolve) => runtime.once("dispatch-error", resolve));
    await fs.writeFile(path.join(queue, "boom.yaml"), 'goal: "kaboom"\n');
    await errorPromise;
    await new Promise((r) => setTimeout(r, 50));

    const errEvt = captured.find((e) => e.type === "dispatch-error");
    assert.ok(errEvt, "expected a dispatch-error event");
    assert.equal(errEvt.role, "ceo");
    assert.match(errEvt.error, /boom/);

    await runtime.stop();
  });
});
```

**Step 2:** Run → PASS.

**Step 5:**
```bash
git commit -am "test(company-runtime): thrown runner error produces dispatch-error event"
```

---

### Task 14: Memory + Roadmap Update

**Files:**
- Modify: `~/.claude/projects/-home-haex-Projekte-haex-corp/memory/architecture_decisions.md`
- Modify: `docs/plans/2026-04-27-roadmap.md`

**Step 1:** Memory `architecture_decisions.md` §1 reformulieren — Kernchanges:
- Title bleibt: "Reporting model: CEO is always informed; graph must be a DAG"
- Body neu: zwei Graphen, `reports_to` (DAG-pflichtig), `delivers_to` (Workflow-Handoff, Zykel erlaubt für Refinement-Loops). Termination-Policy explizit nicht hier sondern Speckit-Prozess.

Vorschlag für den neuen §1 Body:
```markdown
Worker-completion ALWAYS produces an event in the JSONL log addressed to at least the CEO. Two structurally separate graphs:

- **reports_to** (hierarchy edges) — must form a DAG, validated at spec-load. Each agent has 0 or 1 outgoing edge.
- **delivers_to** (workflow-handoff metadata) — declares "my output is substrate for these peers". Cycles ARE allowed: refinement loops (e.g. analyst ⇄ pipeline_builder iterating on a trading strategy) are first-class.

**Why:** Hierarchy (who reports to whom) and workflow (who hands off to whom) are different concepts. Refinement loops are legitimate; only hierarchies must be acyclic. Auto-dispatch on report would risk duplicate work — therefore reports are pure events (no side effects), consumed by the Supervisor (Inkrement 10c) and UI (Inkrement 13).

**How to apply:**
- DAG cycle-detection lives in `spec-loader.js`, on `reports_to` only.
- Existence-check on both fields (typo guard): `E_UNKNOWN_REPORTS_TO`, `E_UNKNOWN_DELIVERS_TO`.
- Termination-policy for refinement loops lives in the per-task speckit spec (`termination:` block in dispatched task YAML), NOT in the agent spec. LLM is primary loop-breaker; Supervisor (10c) is safety net.
- The CEO is the implicit root of `reports_to`; every chain terminates there.
```

**Step 2:** Roadmap aktualisieren:
- Inkrement 10a in der "Already planned" Tabelle: ✅ markieren
- Neue Sektion 10c hinzufügen (zwischen 10a und 10b oder nach 10b — klären):

```markdown
### 10c. Supervisor / Watchdog (NEW — Konsument von 10a + 10b)

Liest Event Log + Task-YAML-`termination:`-Blöcke; erkennt Hänger und
Iterations-Limit-Verletzungen; erzeugt deterministische Interventions-
Tickets in `queue-ceo/` (z.B. "agent X seit 2h ohne Completion-Event,
container check + redispatch"). Kein LLM in der Detection-Schleife —
LLM kommt erst auf der Eskalations-Seite (CEO bekommt Ticket, entscheidet).

Bei kleinen Orgs ist CEO der einzige Eskalations-Empfänger. Bei
größeren Orgs konfigurierbar (`agent.intervene_via: <role>`), sodass
ein dedizierter Ops-Agent als Sub-Supervisor pro Team eingezogen werden
kann (klassisches OTP-Supervision-Tree-Muster).

Voraussetzung: 10a (Event Log) + 10b (SQLite-Index für effiziente Queries).

Effort: ~3-4h.
```

**Step 3:**
```bash
git add docs/plans/2026-04-27-roadmap.md
git commit -m "docs(roadmap): mark 10a complete, add 10c (supervisor) sketch"
```

Memory-Update wird via Write-Tool gemacht (separater Schritt, kein git-commit).

---

### Task 15: Final test-suite run + verification

**Step 1:** Run full suite

```bash
node --test
```

Expected: all green. Pre-existing 200 + ~15 new = ~215 tests.

**Step 2:** Manueller Smoke (optional aber empfehlenswert):
- Frische Company starten
- Task in queue-ceo droppen
- Prüfen: `<projectRoot>/.specops/<slug>/events/YYYY-MM-DD.jsonl` enthält dispatch-started + dispatch-completed
- Prüfen: kein neues Ticket in queue-ceo/ (nur das Ursprungs-Task wird unlinked)

**Step 3:** No commit needed unless smoke turns up issues.

---

## Future-Looking Sketch — Was 10c (Supervisor) auf 10a aufbaut

Damit klar ist, wofür wir das Substrat bauen — als Entwurf, nicht als 10a-Scope:

```javascript
// src/core/supervisor.js  (Inkrement 10c, NICHT 10a)

export class Supervisor {
  constructor({ runtime, eventLog, intervalMs = 30_000 }) { ... }

  async _tick() {
    // 1. Lade letzte N Events aus dem Log
    // 2. Finde dispatch-started ohne match. dispatch-completed/failed/error innerhalb SLA
    // 3. Pro Hänger: Event 'agent-stuck' loggen + Ticket in queue-ceo erzeugen
    // 4. Bei delivers_to-Edge: prüfe, ob Receiver einen Folge-Dispatch
    //    innerhalb erwarteter Pickup-Zeit gestartet hat. Wenn nicht: missed-handoff-Ticket.
    // 5. Bei iteration-chain (parent_task_id → ... → root): zähle Glieder.
    //    Wenn task-yaml.termination.max_iterations überschritten: abort-Ticket an CEO.
  }
}
```

**Lese-Pfade:** Event Log direkt (10a) — später SQLite (10b) für effiziente Queries.
**Schreib-Pfade:** Event Log + Task-YAML in queue-ceo/.
**LLM-Berührung:** keine — Supervisor ist deterministischer Code. LLM erst auf der Eskalations-Empfangsseite (CEO).

---

## Verification Checklist

- [ ] `node --test` runs green
- [ ] Manual smoke: Event Log entsteht; keine spurious tickets
- [ ] reports_to-Cycle wird abgewiesen, delivers_to-Cycle akzeptiert
- [ ] parent_task_id durchgereicht in Events
- [ ] Memory `architecture_decisions.md` §1 reformuliert
- [ ] Roadmap zeigt 10a done + 10c sketch
- [ ] Keine Claude-Attribution in Commit-Messages

---

## Out of Scope (für 10a)

- Supervisor-Loop selbst → 10c
- SQLite-Mirror → 10b
- approval/agent-spawn JSONL events → später (Infrastruktur ist jetzt da, callers folgen)
- Termination-Policy-Schema → speckit-Prozess + Task-YAML
- UI-Verbrauch des Event Logs → 13
- Iteration-Counter im Event → ableitbar aus parent_task_id-Kette
