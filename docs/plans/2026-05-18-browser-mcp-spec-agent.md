# Browser-side Spec Agent + Server REST Tool Surface

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **Status:** Phase 0 in progress (2026-05-18); Phases 1–4 not yet scheduled.
> Supersedes `2026-05-18-untrusted-multi-tenant-isolation.md`.
> Architecture decision: [`docs/adrs/2026-05-18-browser-mcp-architecture.md`](../adrs/2026-05-18-browser-mcp-architecture.md).
> Owner: tbd. Estimated effort: ~6–8 weeks across 5 phases.

**Goal:** Den Speckit-Chat-Agent aus dem Specifyr-Server in den User-Browser verlagern. Der Server stellt nur eine schmale, getypte REST-Tool-Surface bereit und führt selbst keinen LLM- oder Agent-Code mehr aus.

**Architecture:** Browser nutzt Vercel AI SDK gegen einen User-konfigurierten Provider (Anthropic / OpenAI / OpenRouter / Google). Tool-Calls des LLMs landen als REST-Aufrufe gegen ein klar definiertes Specifyr-API-Endpoint-Set oder werden lokal im Browser ausgeführt (IndexedDB-Writes). Pro Projekt gibt es **einen aktuellen Public-State** (= canonical spec auf disk) sowie pro User N private Drafts. Publish ist eine optimistic-concurrency-Operation (compare-and-swap auf `spec_public_version`): wenn der Public-State sich seit Draft-Erstellung bewegt hat, muss der User den Konflikt manuell auflösen bevor Publish gelingt.

**Tech Stack:** Vercel AI SDK (`ai` 4.x) + Provider-Packages (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`), Nuxt 4 / Nitro für REST, Drizzle für DB, IndexedDB im Browser (über `idb` Library), Zod für Tool-Input-Validation.

---

## Motivation

Aktuell läuft `claude-agent-acp` als Child-Prozess im Specifyr-Container. Das hat drei kumulative Risiken:

1. **Cross-Tenant-Leak.** Bind-Mount `/data/projects` ist über alle Orgs sichtbar; ein Prompt-Injection-Bash-Call sieht jedes Org-Projekt.
2. **Server-Compromise via Agent.** Der Agent hat `/var/run/docker.sock`, Network zu Postgres, Env-Vars mit Credentials — eine Code-Execution-Vulnerability im Agent oder im LLM-Output ist effektiv Root am Host.
3. **Per-User-Race.** Zwei Org-Mitglieder am selben Projekt schreiben über dieselbe Bind-Mount; Arbeit eines Users überschreibt die des anderen ungebremst.

Container-Isolation (siehe superseded Plan) löst (1) und teilweise (2), aber nicht (3) ohne separate Per-User-Worktrees. **Browser-side Execution löst alle drei in einem Schritt**, weil:

- LLM und Tool-Definitions leben im Browser — Server hat keinen Code-Execution-Pfad mehr für LLM-Output.
- Plan-Drafts sind per-User (IndexedDB lokal), kein gemeinsamer Server-State.
- Server-Operationen passieren nur über getypte REST-Endpoints, deren Implementation wir kontrollieren — keine `Bash`-Tool-Surface mehr für das LLM.

Hermes-Runtime-Agents (autonome, langlaufende Workflows) sind **außerhalb dieser Scope** und werden später auf separater Hardware deployt.

---

## Architektur

### Komponenten

```
┌────────────────────────────────────────────────────┐
│  Browser (User-Device)                              │
│                                                     │
│  ┌────────────────────────────────────────────┐    │
│  │ Speckit-Chat-UI (Vue 3 / Nuxt-Page)        │    │
│  │                                             │    │
│  │  ┌──────────────────────────────────────┐  │    │
│  │  │ Browser Agent (Vercel AI SDK)        │  │    │
│  │  │  - streamText({ model, tools })      │  │    │
│  │  │  - 5 Tools, alle → REST              │  │    │
│  │  └──────────────────────────────────────┘  │    │
│  │                                             │    │
│  │  ┌──────────────────────────────────────┐  │    │
│  │  │ Spec-Draft Store (IndexedDB)         │  │    │
│  │  │  - conversation history              │  │    │
│  │  │  - current draft files               │  │    │
│  │  └──────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────┘    │
│                                                     │
└─────────┬──────────────────────────────────┬───────┘
          │                                  │
          │ HTTPS (user-API-key)             │ HTTPS (session cookie)
          ▼                                  ▼
┌───────────────────────┐         ┌─────────────────────────────┐
│ Anthropic / OpenAI /  │         │ Specifyr Server              │
│ Google / OpenRouter   │         │  REST Tool Surface:          │
│                       │         │   GET  /files (list)         │
│                       │         │   GET  /files/<path>         │
│                       │         │   POST /search               │
│                       │         │   POST /spec-drafts          │
│                       │         │   PATCH /spec-drafts/<id>    │
│                       │         │                              │
│                       │         │  Kein LLM, kein Agent,       │
│                       │         │  kein Bash, kein Docker      │
│                       │         └─────────────────────────────┘
└───────────────────────┘
```

### Tool-Surface

Zwei Klassen:

**(A) LLM-Tools** — vom Browser-Agent während eines Turns aufgerufen, dem LLM via Vercel-AI-SDK `tools`-Parameter exposed:

| Tool | Backing | Input | Output |
|---|---|---|---|
| `list_files` | REST `GET /api/projects/{id}/files?glob=*` | `{ glob?: string }` | `{ files: [{ path, size, type }] }` |
| `read_file` | REST `GET /api/projects/{id}/files/{*path}` | `{ path: string }` | `{ content, encoding }` |
| `search_code` | REST `POST /api/projects/{id}/search` (ripgrep) | `{ query, glob?, limit? }` | `{ matches: [{ path, line, snippet }] }` |
| `read_existing_spec` | REST `GET /api/projects/{id}/spec-public-state` | `{ name?: string }` (specific file or all) | `{ files: [{ name, content }], version }` |
| `list_my_drafts` | REST `GET /api/projects/{id}/spec-drafts/mine` | none | `{ drafts: [{ id, title, base_version, status, updated_at }] }` |
| `load_draft` | REST `GET /api/projects/{id}/spec-drafts/{draftId}` | `{ draftId }` | `{ title, files, base_version, conversation }` |
| `update_draft_files` | **lokal** — IndexedDB Write, kein REST-Call | `{ files: [{ name, content }] }` | `{ ok: true }` |

**(B) User-Actions** — vom UI ausgelöst, NICHT vom LLM aufrufbar:

| Aktion | Endpoint | Zweck |
|---|---|---|
| Save to Server | `POST /api/projects/{id}/spec-drafts` (new) bzw. `PATCH /api/projects/{id}/spec-drafts/{draftId}` (existing) | Snapshot des aktuellen IndexedDB-Drafts auf Server speichern (für Cross-Device + Audit). Owner only. |
| Publish | `POST /api/projects/{id}/spec-drafts/{draftId}/publish` | Compare-and-swap `base_version` ↔ `spec_public_version`. Bei Match: Files nach disk schreiben, version inkrementieren, draft.status="published". Bei Mismatch: 409 mit Conflict-Diff. |
| Discard | `DELETE /api/projects/{id}/spec-drafts/{draftId}` | Owner verwirft Draft. Tombstone zur Recovery-Prävention oder Hard-Delete — TBD. |

**Bewusst NICHT in der Surface:** kein `write_arbitrary_file`, kein `execute_command`, kein `git_*`, kein `npm_install`, kein `read_git_log`. Was ein autonomer Hermes-Agent später braucht, ist eine eigene, getrennte Surface auf separater Infra.

### Provider-Auswahl im Browser

User-Settings-Seite (`/settings/speckit-agent`) erlaubt Konfiguration **mehrerer Provider-Identities** mit einer aktiven:

```ts
type ProviderIdentity = {
  id: string,                     // local UUID
  label: string,                  // user-chosen, e.g. "My Anthropic Pro"
  provider: "anthropic" | "openai" | "google" | "openrouter",
  model: string,                  // free text, e.g. "claude-opus-4-7"
  apiKey: string,
  baseUrl?: string,
};

type IdentityStoreState = {
  identities: ProviderIdentity[],
  activeIdentityId: string | null,
};
```

**Storage:** Plain IndexedDB. Kein AES-GCM-Encrypt mit Passphrase — die Komplexität wog die UX-Reibung nicht auf (Begründung: Threat-Model "Server-Compromise" ist abgedeckt, "Stolen-Device" ist Sache der OS-Disk-Encryption, "XSS-Exfiltration" durch strikte CSP-Header verhindert).

**Cross-Device:** Kein Sync. Pro Device einmaliges Setup. Server-Side-Storage der Keys ist explizit ausgeschlossen (das war das Kernversprechen des Pivots: Server sieht Provider-Keys nie).

**CSP-Anforderung:** `Content-Security-Policy: default-src 'self'; connect-src 'self' api.anthropic.com api.openai.com generativelanguage.googleapis.com openrouter.ai; ...`. Strikt, damit kein injizierter Script den Key zu einer Drittpartei sendet.

### Spec-Draft-Model

**Pro Projekt: ein aktueller Public-State + N private Drafts (eine pro User pro Initiative).**

```
                    ┌──────────────────────────────────┐
                    │ project.spec_public_version = 5   │
                    │ specs/spec.md, specs/planning.md  │  ← canonical files on disk
                    └──────────────────────────────────┘
                                ▲ Fast-Forward on Publish
                                │
                    ┌───────────┴───────────────────────────┐
                    │ Drafts (private, status="draft")       │
                    │                                         │
                    │ User A: draft #21 base_version=5  ←OK  │
                    │ User A: draft #22 base_version=4  ←needs rebase │
                    │ User B: draft #23 base_version=5  ←OK  │
                    └───────────────────────────────────────┘
```

**Storage:**
- **IndexedDB (primary):** kontinuierliche Persistierung jedes Turns, inklusive Conversation-History + Tool-Call-Log + Draft-Files. Crash-safety im Browser.
- **Server (on manual Save):** User klickt "Save to Server" → kompletter Snapshot (Files + Conversation) wird via REST persistiert. Keine Auto-Save, kein Server-Sync auf Per-Turn-Basis.

**Privacy:**
- `status="draft"` → nur Owner kann lesen (RLS: `owner_user_id = current_user_id`).
- `status="published"` → alle mit project-access sehen, ist Audit-Trail. Ein Draft wird zu `published` durch erfolgreichen Publish; danach bleibt er als History-Eintrag erhalten.

**Publish (Optimistic Concurrency):**
1. User klickt "Publish" auf seinem Draft (status="draft").
2. Server: lock project row, vergleiche `draft.base_version === project.spec_public_version`.
3. **Match:** Files atomisch nach `projects/<org>/<slug>/specs/` schreiben, `project.spec_public_version += 1`, `draft.status = "published"`. 201 Created.
4. **Mismatch:** 409 Conflict mit Body `{ currentPublicVersion, currentPublicFiles }`. UI zeigt Diff zwischen Draft und neuem Public-State. User reconcilet manuell im Draft (kann die neuen Public-Files lesen via `read_existing_spec`-Tool, eigenen Draft via `update_draft_files`-Tool anpassen), klickt "Save to Server" + "Publish" erneut. Beim erneuten Publish wird `base_version` aus dem aktuellen `spec_public_version` neu abgeleitet.

**Mehrere Drafts pro User:**
- Erlaubt. User kann "v1 attempt", "v2 alternative framing", etc. parallel haben.
- Jeder hat eigene `base_version`; alte Drafts werden zu rebase-Kandidaten, wenn Public-State sich bewegt.
- Maximal ein Draft pro User kann "in publish flight" sein (per Lock auf project row).

### Auth-Flow

- Browser ist via existierender Specifyr-Session-Cookie gegenüber dem Server authentifiziert (Authentik-OAuth läuft schon).
- Tool-REST-Calls aus dem Browser tragen den Session-Cookie → Server kennt `userId` + `ownerOrgId` über die übliche `project-access`-Middleware.
- LLM-Calls aus dem Browser gehen direkt an den Provider (Anthropic etc.) mit dem User-API-Key im Header. Specifyr-Server sieht diese Calls nie.

---

## Migration aus dem aktuellen Code

### Was bleibt

- Server: Auth, Org/User/Project-DB-Modell, file-system inside `dataDir/projects/<org>/<slug>/`, ripgrep für Search, Drizzle-Migrations.
- Browser: bestehende Specifyr-Nuxt-App, Component-Library, Auth-Flow.

### Was wird neu gebaut

- 5 REST-Endpoints für die Tool-Surface.
- DB-Tabelle `spec_drafts` (Drizzle-Migration via `pnpm drizzle-kit generate`, NIE Migration-SQL hand-editieren).
- Browser-Bundle für Speckit-Chat: Vercel AI SDK + Tool-Defs + IndexedDB-Store + Streaming-UI.
- Provider-Settings-Seite mit AES-GCM-Encrypt + IndexedDB-Persist.

### Was wird entfernt (Phase 4, nach Stabilisierung)

- `src/runners/acp.js` (AcpRunner) — wenn keine anderen Pfade davon abhängen
- `server/shared/utils/speckit-agent-runner.ts`
- TurnBroker-Plugin (`server/plugins/drain-turn-broker.ts` + Mitspieler)
- Speckit-Chat-Server-Endpoints (alle die `AcpRunner` aufrufen)
- `claude-agent-acp`, `codex-acp`, `gemini-cli` aus dem Specifyr-Dockerfile (kommen nicht mehr zum Einsatz)
- Anthropic-Proxy-Pfad für Speckit (bleibt nur für eventuelle andere Server-Side-Konsumenten — prüfen ob es welche gibt)

---

## Phasen

### Phase 0: Spec + ADR (1–2 Tage)

**Files:**
- Create: [`docs/adrs/2026-05-18-browser-mcp-architecture.md`](../adrs/2026-05-18-browser-mcp-architecture.md)
- Create: [`server/shared/utils/spec-tools-schemas.ts`](../../server/shared/utils/spec-tools-schemas.ts) — Zod sketch
- Create: [`app/lib/speckit-system-prompt.ts`](../../app/lib/speckit-system-prompt.ts) — v1 system prompt
- Modify: `docs/plans/2026-05-18-browser-mcp-spec-agent.md` (dieses Dokument, mit Review-Feedback)

**Aufgaben:**
1. ADR schreiben, das die Entscheidung "Browser statt Container" mit Threat-Model + Trade-offs dokumentiert (Bestandteil siehe Diskussions-Threads im PR von diesem Plan).
2. Tool-Schemas formal als Zod-Schema-Datei skizzieren — vor Implementation, weil das die REST-API-Form festlegt.
3. v1 System-Prompt für den Speckit-Agent als TypeScript-Konstante festlegen (siehe ADR "Resolved Phase-0 Design Questions / 3").

**Verification:** ADR + Plan-Dokument + Schema-Sketch + System-Prompt im Repo, beide Pläne (alt + neu) kreuzverlinkt.

**Commit:** `docs: ADR + zod schema sketch + system prompt for browser-side spec agent`

---

### Phase 1: REST Tool Surface (1.5–2 Wochen)

Server-side endpoints, jeweils TDD-first.

#### Task 1.1: DB-Migration für Draft-Bundle + Public-Version

**Files:**
- Create: `server/shared/database/schema/spec-drafts.ts`
- Modify: `server/shared/database/schema/projects.ts` (add `spec_public_version`)
- Modify: `server/shared/database/schema/index.ts` (export)
- Generated (NIE hand-editieren — siehe MEMORY): `server/shared/database/migrations/NNNN_*.sql` + journal/snapshot

**Schema:**
```ts
export const specDrafts = pgTable("spec_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  title: text("title").notNull(),                                // user-visible label
  status: text("status").$type<"draft" | "published">().notNull().default("draft"),
  baseVersion: integer("base_version").notNull(),                // public version this draft was forked from
  conversation: text("conversation").notNull().default("[]"),    // JSON array, Vercel-AI-SDK message format
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }), // nullable, set on publish
}, (table) => ({
  byProjectOwner: index().on(table.projectId, table.ownerUserId),
  byProjectStatus: index().on(table.projectId, table.status),
}));

export const specDraftFiles = pgTable("spec_draft_files", {
  draftId: uuid("draft_id").notNull().references(() => specDrafts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),                                  // e.g. "spec.md"
  content: text("content").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.draftId, table.name] }),
}));

// In projects schema:
// + specPublicVersion: integer("spec_public_version").notNull().default(0)
```

**Steps:**
1. Schema-Dateien schreiben (spec-drafts.ts neu, projects.ts erweitern).
2. `pnpm drizzle-kit generate` ausführen → Migration wird generiert.
3. RLS-Policies in SEPARATER Migration (Drizzle generiert sie nicht). Beispiele:
   - `spec_drafts`: `(status = 'published' AND project_id IN (SELECT id FROM projects WHERE user_has_project_access(current_setting('app.current_user_id')::uuid, id))) OR (status = 'draft' AND owner_user_id = current_setting('app.current_user_id')::uuid)`
   - `spec_draft_files`: über `draft_id` join auf `spec_drafts`-Policy.
4. `pnpm dev:docker` starten, Migration läuft, Tabellen + RLS existieren.

**Verification:** zwei Test-User in zwei verschiedenen Sessions versuchen jeweils, des anderen status="draft"-Row zu lesen — `SELECT` returnt 0 rows.

**Commit:** `feat(db): spec drafts + public version for browser-side agent`

#### Task 1.2: `GET /api/projects/{id}/files` — List

**Files:**
- Create: `server/api/projects/[id]/files/index.get.ts`
- Test: `tests/api/projects/files-list.test.ts`

**Step 1: Failing test**
```ts
it("lists files within the project directory only", async () => {
  // setup: project with files A, B; second project with file C
  const res = await fetch(`/api/projects/${projectId}/files`, { headers: authHeaders });
  const json = await res.json();
  expect(json.files.map(f => f.path).sort()).toEqual(["A.md", "B.md"]);
  expect(json.files.find(f => f.path === "C.md")).toBeUndefined();
});

it("rejects path traversal in glob param", async () => {
  const res = await fetch(`/api/projects/${projectId}/files?glob=../../**`, { headers: authHeaders });
  expect(res.status).toBe(400);
});
```

**Step 2: Implement endpoint**
- Use `project-access` middleware (existiert) für Authz.
- Validate `glob` via Zod, reject `..` und absolute Pfade.
- `fast-glob` mit `cwd` = project-dir, `dot: false`, `onlyFiles: false`.

**Step 3: Verify both tests pass.**

**Commit:** `feat(api): list project files endpoint`

#### Task 1.3: `GET /api/projects/{id}/files/{*path}` — Read

**Files:**
- Create: `server/api/projects/[id]/files/[...path].get.ts`
- Test: `tests/api/projects/files-read.test.ts`

**Critical:** Path-Traversal-Schutz ist **die zentrale Security-Boundary**. Test muss explizit `..` und symlinks abdecken.

**Tests:**
- Read normaler Datei
- Reject `../../etc/passwd`
- Reject Symlinks außerhalb des Projekt-Roots (via `fs.realpath` + Vergleich mit `project-dir`)
- Reject Pfade die nicht im project-dir sind

**Implementation:** Use `path.resolve` + `path.relative` + prüfen ob das Ergebnis nicht mit `..` beginnt.

**Commit:** `feat(api): read project file endpoint with path-traversal protection`

#### Task 1.4: `POST /api/projects/{id}/search` — Code Search

**Files:**
- Create: `server/api/projects/[id]/search.post.ts`
- Test: `tests/api/projects/search.test.ts`

**Implementation:** Spawn `rg --json --glob ... query` im project-dir, parse Output, limitieren auf z.B. 100 Matches. ripgrep ist bereits im Specifyr-Dockerfile installiert (per `apk add ripgrep` oder analog).

**Tests:**
- Search findet known content
- Honors glob filter
- Limits result count
- Reject query mit shell-metacharacters? — eigentlich nicht nötig, weil wir argv-Array nutzen, kein shell. Aber Test trotzdem als Doku.

**Commit:** `feat(api): code search endpoint via ripgrep`

#### Task 1.5: Spec-Draft CRUD-Endpoints

**Files:**
- Create: `server/api/projects/[id]/spec-drafts/index.post.ts` (create new draft)
- Create: `server/api/projects/[id]/spec-drafts/index.get.ts` — wirft 404, weil "alle Drafts" sinnlos ist
- Create: `server/api/projects/[id]/spec-drafts/mine.get.ts` (list my drafts)
- Create: `server/api/projects/[id]/spec-drafts/[draftId].get.ts` (read single draft + files + conversation)
- Create: `server/api/projects/[id]/spec-drafts/[draftId].patch.ts` (update existing — "Save to Server")
- Create: `server/api/projects/[id]/spec-drafts/[draftId].delete.ts` (discard)
- Test: `tests/api/projects/spec-drafts-crud.test.ts`

**Endpoint-Semantik:**
- `POST /spec-drafts` mit `{ title, baseVersion, files, conversation }` → 201, `{ draftId, updatedAt }`. `baseVersion` muss <= `project.spec_public_version` sein.
- `GET /spec-drafts/mine` → `{ drafts: [{ id, title, baseVersion, status, updatedAt, publishedAt }] }` für caller's drafts in diesem Projekt.
- `GET /spec-drafts/{id}` → `{ title, files, baseVersion, conversation, status }`. Owner kann always lesen; Published auch für andere; Draft fremder User: 404.
- `PATCH /spec-drafts/{id}` mit `{ title?, files?, conversation? }`. Owner only. Setzt `updatedAt`. Files-Update ersetzt den ganzen Bundle (vereinfacht Diff-Tracking).
- `DELETE /spec-drafts/{id}` — Owner only, nur wenn `status="draft"` (published kann nicht gelöscht werden für Audit-Trail).

**Tests (TDD, je Endpoint einzeln):**
- POST mit `baseVersion > spec_public_version` → 400
- User A kann User B's draft (status="draft") NICHT lesen → 404
- Published drafts: andere User-im-Projekt sehen sie → 200
- PATCH von fremdem User → 403
- DELETE von published → 409 ("cannot delete published draft")

**Commits (5 separate, einer pro Endpoint, jeweils TDD):**
- `feat(api): create spec draft`
- `feat(api): list my spec drafts`
- `feat(api): get spec draft`
- `feat(api): patch spec draft (owner only)`
- `feat(api): delete spec draft (owner only, drafts only)`

#### Task 1.6: Publish-Endpoint mit Compare-and-Swap

**Files:**
- Create: `server/api/projects/[id]/spec-drafts/[draftId]/publish.post.ts`
- Create: `server/shared/utils/spec-publish.ts` (transactional logic)
- Test: `tests/api/projects/spec-drafts-publish.test.ts`

**Logik:**
```ts
// In a transaction:
1. SELECT spec_public_version FROM projects WHERE id = :projectId FOR UPDATE;
2. SELECT base_version, files FROM spec_drafts JOIN spec_draft_files WHERE id = :draftId AND owner = :user AND status = "draft";
3. IF draft.base_version != project.spec_public_version: ROLLBACK, return 409 with { currentPublicVersion, currentPublicFiles }
4. Write files to disk: projects/<org>/<slug>/specs/<name> (atomic: write to .tmp + rename per file)
5. UPDATE projects SET spec_public_version = spec_public_version + 1 WHERE id = :projectId;
6. UPDATE spec_drafts SET status = "published", published_at = NOW() WHERE id = :draftId;
7. COMMIT.
```

**Critical:**
- Disk-Write + DB-Update müssen entweder beide gelingen oder beide nicht. Implementation: schreibe Files ins `specs/`-Verzeichnis NACH erfolgreichem DB-Update? Oder vorher? Lock auf project + write-then-update + rollback-if-disk-fails ist sicherer. Konkret: tmp-Verzeichnis schreiben, beim Commit per `fs.renameSync` atomisch umbenennen, bei Fehler im DB-Commit `rm -rf` des tmp.
- Path-Traversal-Schutz: `name`-Field jedes Files validieren (kein `..`, kein absoluter Pfad).

**Tests:**
- Happy path: 2 Files Draft → Publish → specs/ contains both, version inkrementiert, draft.status="published"
- Conflict: User A & B fork von version=5; A publishes (succ, version=6); B publishes → 409 mit B's draft.base_version=5 vs. current=6
- Disk-write fail (z.B. permission) → DB rollback, draft bleibt draft
- User tries to publish another user's draft → 403
- Re-publish einer bereits published Drafts → 409 oder 400

**Commit:** `feat(api): publish spec draft with optimistic concurrency`

#### Task 1.7: `GET /api/projects/{id}/spec-public-state` — Read Current Public State

**Files:**
- Create: `server/api/projects/[id]/spec-public-state/index.get.ts`
- Create: `server/api/projects/[id]/spec-public-state/[name].get.ts` (single file)
- Test: `tests/api/projects/spec-public-state.test.ts`

**Semantik:**
- `GET /spec-public-state` → `{ version, files: [{ name, content }] }` für ALLE files in `specs/`.
- `GET /spec-public-state/{name}` → `{ version, name, content }` für einen einzelnen File.
- Version-Counter kommt aus `projects.spec_public_version`. Browser nutzt das als `baseVersion` bei neuen Drafts.

**Path-Traversal-Schutz** für `name`-Param analog Task 1.3.

**Tests:**
- Project ohne Specs (specs/ leer) → `{ version: 0, files: [] }`
- Specs vorhanden → korrekte Files + Version
- name mit `..` → 400

**Commit:** `feat(api): read current public spec state`

---

### Phase 2: Browser Agent (2–2.5 Wochen)

#### Task 2.1: Dependencies + CSP-Headers

**Files:**
- Modify: `package.json` (add `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `idb`)
- Modify: `nuxt.config.ts` (CSP-Headers in nitro routeRules)

**CSP:**
```ts
nitro: {
  routeRules: {
    "/projects/**": {
      headers: {
        "Content-Security-Policy": [
          "default-src 'self'",
          "connect-src 'self' https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com https://openrouter.ai",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",  // tailwind
          "img-src 'self' data:",
        ].join("; "),
      },
    },
  },
}
```

**Verification:** Browser DevTools → Network → Response Headers zeigen CSP. Test im Browser: `fetch("https://evil.com")` aus Speckit-Page wird vom Browser blockiert.

**Commit:** `feat(speckit): deps + strict CSP for browser agent`

#### Task 2.2: Provider-Identity-Store (Multi-Identity)

**Files:**
- Create: `app/lib/provider-identity-store.ts`
- Create: `app/composables/useProviderIdentity.ts`
- Test: `tests/unit/provider-identity-store.test.ts` (vitest mit `fake-indexeddb`)

**Store-API:**
```ts
interface ProviderIdentityStore {
  list(): Promise<ProviderIdentity[]>;
  get(id: string): Promise<ProviderIdentity | null>;
  add(identity: Omit<ProviderIdentity, "id">): Promise<string>;        // returns new id
  update(id: string, patch: Partial<ProviderIdentity>): Promise<void>;
  remove(id: string): Promise<void>;
  getActive(): Promise<ProviderIdentity | null>;
  setActive(id: string | null): Promise<void>;
}
```

**Storage:** IndexedDB `speckit` DB, ObjectStore `providerIdentities` (keyed by id) und `meta` (für `activeIdentityId`).

**Tests:**
- add → list returnt new identity
- setActive(id) → getActive returnt diese identity
- remove(activeId) → getActive returnt null
- update preserves other fields

**Commit:** `feat(speckit): multi-identity provider store in IndexedDB`

#### Task 2.3: Settings-Page für Provider-Identities

**Files:**
- Create: `app/pages/settings/speckit-agent.vue`
- Create: `app/components/speckit/ProviderIdentityList.vue`
- Create: `app/components/speckit/ProviderIdentityForm.vue`

**UI:**
- Liste der konfigurierten Identities mit Active-Badge
- Pro Eintrag: Edit / Delete / Set Active
- "+ Add Identity"-Button öffnet Form
- Form-Felder: Label, Provider-Dropdown, Model (free text), API-Key (type=password), Base-URL (optional)
- Save schließt Form, refresht Liste

**Commit:** `feat(ui): speckit provider identity settings page`

#### Task 2.4: Spec-Draft IndexedDB Store

**Files:**
- Create: `app/lib/spec-draft-store.ts`
- Test: `tests/unit/spec-draft-store.test.ts`

**Datenmodell (IndexedDB):**
```ts
type LocalDraft = {
  id: string,                        // local UUID
  serverId: string | null,           // populated nach Save-to-Server
  projectId: string,
  title: string,
  baseVersion: number,
  files: Record<string, string>,     // name → content
  conversation: Message[],           // Vercel-AI-SDK format
  status: "draft" | "published",
  createdAt: string,
  updatedAt: string,
  dirty: boolean,                    // true = changes since last Save-to-Server
};
```

**Store-API:**
```ts
interface SpecDraftStore {
  listLocalDrafts(projectId): Promise<LocalDraftSummary[]>;
  loadLocalDraft(id): Promise<LocalDraft>;
  createLocalDraft(projectId, title, baseVersion, files): Promise<string>;
  updateLocalDraft(id, patch: Partial<LocalDraft>): Promise<void>;
  appendTurn(id, turn: Message): Promise<void>;
  updateFiles(id, files: Record<string, string>): Promise<void>;
  markDirty(id, dirty): Promise<void>;
  deleteLocalDraft(id): Promise<void>;
  // Server-Sync
  saveToServer(id): Promise<{ serverId, updatedAt }>;
  fetchFromServer(projectId, serverDraftId): Promise<LocalDraft>;
}
```

**Tests:** Standard CRUD + Sync-Roundtrip mit gemockten $fetch.

**Commit:** `feat(speckit): local spec draft store with server sync`

#### Task 2.5: Browser Tool Definitions

**Files:**
- Create: `app/lib/speckit-tools.ts`
- Test: `tests/unit/speckit-tools.test.ts`

Definiert die 7 LLM-Tools für Vercel AI SDK (siehe Tool-Surface oben). Beispiel:

```ts
import { tool } from "ai";
import { z } from "zod";

export function buildSpeckitTools(ctx: { projectId: string; currentLocalDraftId: string }) {
  return {
    list_files: tool({
      description: "List files in the current project, optionally filtered by glob",
      inputSchema: z.object({ glob: z.string().optional() }),
      execute: async ({ glob }) => {
        return await $fetch(`/api/projects/${ctx.projectId}/files`, { query: { glob } });
      },
    }),
    update_draft_files: tool({
      description: "Update the current draft's files. Replaces the named file's content. Use this to write spec content.",
      inputSchema: z.object({
        files: z.array(z.object({ name: z.string(), content: z.string() })),
      }),
      execute: async ({ files }) => {
        // LOCAL only — writes to IndexedDB, NO server call
        const fileMap = Object.fromEntries(files.map((f) => [f.name, f.content]));
        await draftStore.updateFiles(ctx.currentLocalDraftId, fileMap);
        await draftStore.markDirty(ctx.currentLocalDraftId, true);
        return { ok: true, files: files.map((f) => f.name) };
      },
    }),
    // ... read_file, search_code, read_existing_spec, list_my_drafts, load_draft
  };
}
```

**Tests:** Für jedes Tool: mock $fetch + draftStore, verify dass die korrekten Calls gemacht werden.

**Commit:** `feat(speckit): browser-side tool definitions`

#### Task 2.6: Browser-Agent Composable

**Files:**
- Create: `app/composables/useSpeckitAgent.ts`
- Test: `tests/unit/use-speckit-agent.test.ts`

**API:**
```ts
const {
  localDraft,         // Ref<LocalDraft>
  isStreaming,        // Ref<boolean>
  currentToolCall,    // Ref<ToolCall | null>
  sendMessage,        // (text: string) => Promise<void>
  cancel,             // () => void
  saveToServer,       // () => Promise<void>  — User-Action
  publish,            // () => Promise<{ ok } | { conflict: ConflictInfo }>  — User-Action
} = useSpeckitAgent({ projectId, localDraftId });
```

Internally:
- Lädt aktive Provider-Identity via `useProviderIdentity().getActive()`
- Konstruiert `streamText({ model: providerForIdentity(identity), tools: buildSpeckitTools({...}), messages: localDraft.conversation, system: SPECKIT_SYSTEM_PROMPT })`
- Bei jedem `onChunk`: Conversation in IndexedDB persistieren (via draftStore.appendTurn)
- `saveToServer()` ruft `draftStore.saveToServer(localDraftId)`
- `publish()` ruft erst saveToServer, dann `POST /spec-drafts/{serverId}/publish`; bei 409 returnt ConflictInfo (UI rendert Diff)

**Tests:** Mock-Provider via Vercel AI SDK's `MockLanguageModelV1`. Verify:
- Happy path: text + tool_call + result → conversation in IndexedDB komplett, dirty=true
- Cancel mid-stream → IndexedDB-State konsistent (kein partial turn)
- Tool-Error → in Conversation als error-message, Stream geht weiter
- Publish-Conflict → returnt ConflictInfo statt zu throwen

**Commit:** `feat(speckit): browser agent composable`

#### Task 2.7: Speckit-Chat-Page UI

**Files:**
- Modify: `app/pages/projects/[orgSlug]/[slug]/specs/index.vue`
- Create: `app/components/speckit/ChatPanel.vue`
- Create: `app/components/speckit/DraftSidebar.vue` (list local + server drafts)
- Create: `app/components/speckit/ToolCallBadge.vue`
- Create: `app/components/speckit/PublishDialog.vue` (conflict-resolution UI)

**UI-Flow:**
- Page-Load: load active identity + project's public-state + my server-drafts via REST
- Sidebar: Liste aller meiner Drafts (local + server-synced), "New Draft"-Button basiert neuer auf aktuellem public-state
- Center: ChatPanel mit streaming-Messages + Tool-Call-Badges
- Toolbar: "Save to Server" (disabled wenn `!dirty`), "Publish" (disabled wenn `!serverId`)
- Conflict-Dialog: Diff-View "your draft vs new public state", User editiert oder cancelt

Feature-Flag `useBrowserAgent` toggled zwischen altem Server-Side-Chat und neuem Browser-Agent.

**Commit:** `feat(ui): browser-side speckit chat page`

---

### Phase 3: Migration + Feature Flag (1 Woche)

#### Task 3.1: Feature-Flag in App-Config

**Files:**
- Modify: `nuxt.config.ts` (`runtimeConfig.public.useBrowserAgent`)
- Modify: `app/pages/projects/[orgSlug]/[slug]/specs/index.vue` (toggle between old/new)

**Commit:** `feat: feature flag for browser-agent rollout`

#### Task 3.2: Data-Migration für existierende Speckit-Plans

**Files:**
- Create: `scripts/migrate-existing-specs-to-drafts.ts`

Existierende Specs liegen als Files unter `projects/<org>/<slug>/specs/`. Beim ersten Login eines Users in einem migrierten Projekt: optional „import existing spec as draft" — One-shot, nicht automatisch.

**Commit:** `chore(migration): import existing specs as drafts script`

#### Task 3.3: Browser-Agent als Default umstellen

**Files:**
- Modify: `nuxt.config.ts` (Default `useBrowserAgent = true`)

Nach 1–2 Wochen Beta mit Volunteers. Rollback-Switch bleibt für 1 weitere Woche.

**Commit:** `chore: default speckit chat to browser agent`

---

### Phase 4: Cleanup (1 Woche)

**Voraussetzung:** Phase 3 ist seit mindestens 2 Wochen in Produktion ohne Rollback.

#### Task 4.1: Server-Side Speckit-Agent-Code entfernen

**Files (entfernen):**
- `src/runners/acp.js`, `src/runners/claude-code.js`, `src/runners/claude-stream-to-acp.js`
- `server/shared/utils/speckit-agent-runner.ts`
- `server/plugins/drain-turn-broker.ts`
- Alle `server/api/chat/...`-Endpoints die `AcpRunner` aufrufen
- Test-Fixtures dazu

**Vorsicht:** vorher grep, ob andere Pfade davon abhängen (z.B. die Hermes-Runtime nutzt davon nichts, aber genau prüfen). Wenn ja: Refactor vor dem Löschen.

**Commit:** `chore: remove server-side speckit agent execution`

#### Task 4.2: `claude-agent-acp` aus Specifyr-Dockerfile entfernen

**Files:**
- Modify: `Dockerfile` (entferne die `npm install -g @agentclientprotocol/...`-Block)

**Commit:** `chore(docker): drop claude-agent-acp from server image`

#### Task 4.3: Feature-Flag entfernen

**Files:**
- Modify: `nuxt.config.ts` (Flag weg)
- Modify: relevante UI-Stellen

**Commit:** `chore: remove feature flag after browser-agent stable`

---

## Risiken + Offene Fragen

### Bekannte Risiken

| Risiko | Wahrscheinlichkeit | Mitigation |
|---|---|---|
| Browser-CORS-Restrictions verhindern direkte Anthropic-Calls | hoch | Anthropic erlaubt mit `anthropic-dangerous-direct-browser-access: true`. Vercel AI SDK setzt das automatisch. |
| Provider-API-Key landet in IndexedDB → XSS-Vektor | mittel | AES-GCM mit user-passphrase derived key. Documenten: Specifyr hat keine User-injizierte HTML/JS-Render-Pfade (zod-validated Inputs). Strenge CSP-Headers in Phase 1. |
| Tool-Call-Latenz fühlt sich langsam an | mittel | Batch-Tool-Endpoint als Fallback wenn UX-Tests es zeigen. |
| Spec-Quality schlechter als heute (anderes Tool-Set) | mittel | A/B mit Beta-User für 2 Wochen vor Default-Switch. Detaillierte Tool-Descriptions + System-Prompt-Tuning. |
| Cross-Device-Continuity gebrochen (IndexedDB ist lokal) | niedrig | Auto-Sync-zum-Server-Pfad (Task 2.6) deckt das ab, sofern User die Provider-Identity auf jedem Device setzt. |

### Geklärte Entscheidungen (aus Walkthrough mit Stakeholder, 2026-05-18)

| Frage | Entscheidung | Begründung |
|---|---|---|
| Tool-Surface: Cross-Device-Resume | `list_my_drafts` + `load_draft` als Tools beifügen | Sonst wäre Server-Sync sinnlos |
| Multi-File-Specs: Schema | Draft-Bundle (`spec_drafts` + `spec_draft_files`) | Atomic Publish, klare Gruppierung |
| `read_git_log`-Tool | Nicht initial, später wenn Bedarf | YAGNI, schmale Surface |
| Auto-Save zum Server | Nur manuell ("Save to Server"-Button) | IndexedDB reicht für Crash-Safety, weniger Server-Load |
| Draft-Sichtbarkeit | Nur Owner sieht Drafts (status="draft") | Klare Privacy-Boundary |
| Canonical-Merge | Single Public-State + Optimistic-Concurrency Publish | Konflikt-Resolution durch User vor Publish |
| Post-Publish-Lifecycle | Draft bleibt als published History sichtbar | Audit-Trail |
| API-Key-Storage | Plain IndexedDB mit strikter CSP | UX > Passphrase-Theater bei realistischem Threat-Model |
| Cross-Device-Sync der Identity | Kein Sync, per-Device-Setup | Server sieht Keys nie |
| Provider-Granularität | Mehrere Identities pro User, eine aktiv | Flexibel ohne pro-Projekt-Konfig |
| Tool-Call-Telemetrie | Nein, Server-Access-Logs reichen | Nachträglich nachziehbar |
| Conversation-Server-Storage | Files + Conversation, beides | Cross-Device-Resume inkl. Chat-Kontext |
| `oauth_credentials`-Schicksal | In Phase 4 grep-and-remove falls unbenutzt | Aufgeräumtere Codebase |

### In Phase 0 geklärte Fragen (2026-05-18)

Vollständige Begründung in der [ADR](../adrs/2026-05-18-browser-mcp-architecture.md#resolved-phase-0-design-questions).

1. **Discard-Semantik:** Hard-delete für `status="draft"`. `status="published"` ist immutable (Audit-Trail) → 409 bei DELETE.
2. **Multi-Tab-Concurrency innerhalb eines Users:** Last-write-wins. UI zeigt via `BroadcastChannel` eine Warnung, wenn derselbe Draft in mehreren Tabs offen ist. Kein CRDT, kein OT.
3. **System-Prompt:** v1 als TypeScript-Konstante in [`app/lib/speckit-system-prompt.ts`](../../app/lib/speckit-system-prompt.ts) eingecheckt. Iteration während Phase 2.

### Out of Scope (separat zu planen)

- Hermes-Runtime-Agents (autonome langlaufende Workflows) — auf separater Hardware, eigenes Repository.
- Browser-side MCP-Server-Discovery (User installiert eigene MCP-Tools) — Browser-Plug-In-Pattern, deutlich später.
- Plan-Draft Realtime-Collaboration (CRDT-Merging zweier paralleler Drafts) — manueller Review/Merge reicht initial.

---

## Definition of Done

- Alle 5 REST-Endpoints implementiert, getestet, mit Path-Traversal-Schutz.
- Browser-Agent läuft Speckit-Chat-Flow E2E mit mindestens Anthropic + OpenAI Provider.
- Conversation + Draft persistieren in IndexedDB UND syncen zum Server.
- `Dockerfile` enthält keinen `@agentclientprotocol/claude-agent-acp` mehr.
- E2E-Test in `tests/e2e/speckit-browser-agent.test.ts`: Login → Provider-Config → New Project → Speckit-Chat-Session mit mindestens 2 Tool-Calls (read_file + save_draft) → Publish Draft → Diff sichtbar.
- Server-Side-AcpRunner-Code entfernt (Phase 4 erreicht).
- ADR + Dieses Plan-Dokument verlinkt von einem CHANGELOG-Eintrag.
