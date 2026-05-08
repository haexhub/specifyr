# Plan: Zod für Input-Validation auf Server-Endpoints

**Stand:** 2026-05-08
**Trigger:** Review-Feedback auf PR #15 — `admin/orgs.get.ts` parst Limit/Offset
manuell mit `parseInt` + clamp. Statt das pro Endpoint zu wiederholen, will
die Codebase eine zentrale Schema-Validation.

## Ausgangslage

Heute parst jeder Endpoint Inputs ad-hoc:

```ts
// server/api/admin/orgs.get.ts
const q = getQuery(event);
const limit = Math.min(
  Math.max(Number.parseInt(String(q.limit ?? 50), 10) || 50, 1),
  200,
);
const offset = Math.max(Number.parseInt(String(q.offset ?? 0), 10) || 0, 0);
```

```ts
// server/api/orgs/index.post.ts
const body = await readBody<{ name?: string }>(event);
const name = body?.name?.trim() ?? "";
if (name.length < 2) {
  throw createError({ statusCode: 400, statusMessage: "name must be at least 2 chars" });
}
```

```ts
// server/api/projects.post.ts
const body = await readBody<{ title?: string; ownerOrgSlug?: string | null; … }>(event);
const title = body?.title?.trim() ?? "";
if (!title) {
  throw createError({ statusCode: 400, statusMessage: "Project title is required." });
}
```

**Probleme:**
- TypeScript-Cast (`readBody<T>`) prüft zur Laufzeit nichts — die Generic
  ist nur ein Type-Hint, das Server vertraut dem Client.
- 400-Messages werden pro Endpoint neu erfunden, kein einheitliches
  Error-Format.
- `Math.min(Math.max(parseInt(…)))`-Idiome sind boilerplate-lastig und
  haben subtile Bugs (e.g. `parseInt("abc")` ist `NaN` → `NaN || default`
  funktioniert nur, weil `NaN` falsy ist; kein Schutz vor `"50abc"` das
  zu `50` parst).
- Coercion-Regeln (e.g. "ist ein leerer String erlaubt?") sind über
  20+ Endpoints inkonsistent.

**Scope-Vermessung:**
- `grep readBody< server/` → 24 Files
- `grep "getQuery\|getRouterParam" server/` → 62 Files
- Keine bestehende Validation-Library: weder `zod`, `valibot`, `@vinejs/vine`.

## Ziel

`zod` als Single-Source-of-Truth für API-Input-Validation. h3 hat
[`getValidatedQuery`](https://h3.unjs.io/utils/request#getvalidatedqueryevent-validate),
[`readValidatedBody`](https://h3.unjs.io/utils/request#readvalidatedbodyevent-validate)
und [`getValidatedRouterParams`](https://h3.unjs.io/utils/request#getvalidatedrouterparamsevent-validate)
out-of-the-box, die ein `(input) => parsed`-Validator akzeptieren — Zods
`schema.parse` matched die Signatur.

**Vorher / Nachher:**

```ts
// Before — admin/orgs.get.ts
const q = getQuery(event);
const limit = Math.min(Math.max(Number.parseInt(String(q.limit ?? 50), 10) || 50, 1), 200);
const offset = Math.max(Number.parseInt(String(q.offset ?? 0), 10) || 0, 0);

// After
const { limit, offset } = await getValidatedQuery(
  event,
  paginationSchema.parse,
);
```

```ts
// Before — orgs/index.post.ts
const body = await readBody<{ name?: string }>(event);
const name = body?.name?.trim() ?? "";
if (name.length < 2) throw createError({ statusCode: 400, statusMessage: "name must be at least 2 chars" });

// After
const { name } = await readValidatedBody(event, createOrgSchema.parse);
```

Bei Schema-Verstoß wirft Zod einen `ZodError` mit feldbezogenen Details;
ein zentraler Error-Handler in einem Nitro-Plugin mappt den auf eine
saubere 400-Response.

## Effort

~4-5h für die volle Migration (24 Body-Endpoints + ~10-15 Query-/Param-
Endpoints, der Rest braucht keine Validation-Logik). Aufteilung pro
Domain (admin/, orgs/, projects/, me/) macht den Diff lesbar.

## Schritte

### 1. Dependency + zentrale Schema-Datei

```bash
pnpm add zod
```

Neue Datei `server/utils/validation.ts`:

```ts
import { z } from "zod";

/** Pagination-Query-Helper, in /api/admin/* + andere Listen-Endpoints. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Org-slug aus Route-Param (URL-safe, lower-case Match auf orgs.slug). */
export const orgSlugParam = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
});

export const userIdParam = z.object({
  userId: z.string().uuid(),
});

/** Schemata pro Domain als sub-objects oder eigene exports — siehe Schritt 3. */
```

### 2. Zentraler ZodError → 400 Mapper

`server/plugins/zod-error-handler.ts`:

```ts
import { ZodError } from "zod";

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("error", (error, { event }) => {
    if (error instanceof ZodError && event) {
      // Replace the thrown error with a structured 400.
      // Zod's `issues` array has { path, message, code } per problem.
      throw createError({
        statusCode: 400,
        statusMessage: "Invalid input",
        data: { issues: error.issues },
      });
    }
  });
});
```

→ verify: ein Endpoint mit Zod-Schema → curl mit ungültiger Payload →
Response ist `{ statusCode: 400, statusMessage: "Invalid input", data: {issues: […]} }`.

### 3. Migration pro Domain

**Reihenfolge nach Risiko/Test-Coverage:**

#### 3a. `/api/admin/*` (4 Files, low traffic)

- `admin/users.get.ts`, `admin/orgs.get.ts` → `getValidatedQuery(paginationSchema)`
- `admin/settings.patch.ts` → `readValidatedBody` mit:

  ```ts
  z.object({
    registration: z.object({
      policy: z.enum(["open", "domain", "closed"]).optional(),
      allowedDomains: z.array(z.string().min(1)).optional(),
    }).optional(),
  });
  ```

#### 3b. `/api/orgs/*` (8 Files)

- `orgs/index.post.ts` → `z.object({ name: z.string().trim().min(2).max(120) })`
- `orgs/[slug]/invites.post.ts` → email + role
- `orgs/[slug]/members/[userId]/role.patch.ts` → role enum
- `orgs/[slug]/transfer-ownership.post.ts` → `newOwnerUserId: z.string().uuid()`
- Route-Params (`slug`, `userId`) via `getValidatedRouterParams`

#### 3c. `/api/projects/*` (~10 Files)

- `projects.post.ts` → title, description, extensions, workflow, ownerOrgSlug
- `projects/[slug]/workflow.post.ts`, `extensions.post.ts`, `secrets.post.ts`,
  etc. — pro File ein eigenes Schema, in `validation.ts` o.ä. konsolidiert.

#### 3d. `/api/me/*` + Rest (4-6 Files)

- `me/llm-credentials/index.post.ts`, `[id].patch.ts`,
  `oauth/anthropic/[id]/code.post.ts`
- Symmetrisch für `/api/orgs/[slug]/llm-credentials/*`

#### 3e. `/api/invites/*` + `/api/dev/*` + Misc

- Was übrig ist — typischerweise nur Route-Params zu validieren.

### 4. Test

- Bestehende DB-Tests laufen weiter durch (sie testen die Service-Layer,
  nicht den Validation-Step).
- Pro Endpoint einen E2E-style-Test: ein gültiger + ein ungültiger
  Request, Status-Code-Check. Zod-Fehlermeldungen werden so verifiziert.
- Smoke pro Domain via Browser/Curl nach jedem Migrations-Step.

### 5. Optional: TypeScript-Inferenz nutzen

`z.infer<typeof schema>` ersetzt manuelle `interface`-Deklarationen für
Body-Typen. Das räumt einen weiteren ad-hoc-Stil auf:

```ts
const createOrgSchema = z.object({ name: z.string().trim().min(2) });
type CreateOrgInput = z.infer<typeof createOrgSchema>;  // { name: string }
```

## PR-Strategie

Optionen:
- **Ein PR pro Domain** (3a–3e als 5 PRs). Saubere Review-Häppchen,
  aber 5x Kontext-Switch.
- **Ein Big-Bang-PR** mit Domain-by-Domain-Commits. Reviewer kann pro
  Commit durchgehen. Ein einziger Smoke-Pass am Ende.

Empfehlung: Big-Bang, weil die zentralen Schema-Datei + Error-Handler
ohnehin nur einmal eingeführt wird; pro-Domain-PRs würden die
gegenseitig blocken.

## Pitfalls

- **`z.coerce.number()` vs. URL-Strings.** Query-Params kommen als
  String an. `z.coerce.number()` parst — aber `"50abc"` wird zu `NaN`
  gefiltert (gut, weil dann das Schema reject'd; im manuellen
  parseInt-Code würde es zu `50` werden, also strikteres Verhalten).
  Falls existierende Clients darauf angewiesen sind, vorher prüfen.
- **`readValidatedBody` vs. `readBody` mit Generic.** `readBody<T>(event)`
  hat keinerlei Runtime-Check. Ersetzt man's durch `readValidatedBody`,
  sind Schema-Verstöße jetzt Errors, die vorher stillschweigend mit
  `undefined`-Felder durchliefen. Pro Endpoint kurz prüfen, ob das den
  Frontend-Pfad bricht (z.B. wenn UI bisher leere POST-Bodies
  geschickt hat, die der Server tolerierte).
- **ZodError-Handler-Hook-Reihenfolge.** Der `nitroApp.hooks.hook("error")`
  feuert vor dem Default-500-Path; aber wenn der Endpoint den Error
  schon gefangen + neu wirft, sieht der Hook den ZodError nicht mehr.
  Daher `parse` direkt aufrufen, NICHT in try/catch wrappen.
- **`z.string().email()` ist liberal.** Akzeptiert Sachen wie
  `a@b` ohne TLD. Falls strenger nötig, eigenes Regex.

## Out-of-Scope

- **Frontend-side Validation.** Composables/Components rufen Endpoints
  weiterhin ohne Pre-Validation auf. Server-side reject ist die
  Source-of-Truth; UI kann das später spiegeln (separater PR).
- **OpenAPI-Generation aus Zod-Schemas.** `zod-to-openapi` o.ä. wäre ein
  Bonus, aber nichts was hier blockt.
- **Drizzle-Schema-Validierung verheiraten.** Zod und Drizzle haben
  keine Out-of-the-Box-Sync. `drizzle-zod` könnte zukünftig automatisch
  Zod-Schemas aus DB-Tabellen ableiten, aber das ist ein eigener
  Meta-PR.
