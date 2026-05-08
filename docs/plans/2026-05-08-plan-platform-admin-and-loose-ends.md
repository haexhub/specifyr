# Plan: Platform Admin + Org-Roles + Cleanups

**Stand:** 2026-05-08
**Vorgänger:** [2026-05-08-handoff-deploy-and-loose-ends.md](./2026-05-08-handoff-deploy-and-loose-ends.md)
**Explizit deferred:** Live-OAuth-Test (Phase 8/9), Stripe / Billing (Phase B)

## Ausgangslage

v0.5.0 ist live. Authentik ist als IDP up mit dediziertem least-priv DB-user.
Logout funktioniert (PR #11). Multi-tenant LLM creds + proxy laufen.

User-Klärung 2026-05-08:
- Multi-admin-Modell auf Org-Ebene: org-admin promoted member zum admin
  ohne selber Rechte zu verlieren. Aktuell nur "admin" als Rolle, weitere
  Rollen kommen später.
- Es soll eine **Platform-Admin-Settings-Seite** geben:
  - Übersicht aller User + Organisationen
  - Self-Registration-Policy (offen / domain-restricted / geschlossen)
  - Erweiterungspunkt für künftige Settings
- **Mandatory-Org-Modell:** Projekte sind ausnahmslos org-owned. Erste
  User-Action nach Self-Reg: Org anlegen, dabei Owner werden. Owner ist nicht
  entfernbar bis er via `transfer-ownership` an einen anderen Member abgibt.
- **Identity-Modell A** (globale Identity): User hat eine Email global
  unique, Membership-Rows verknüpfen ihn mit N Orgs. Kein per-org-User-Row.
- **Keine Migration nötig:** auf prod liegt nichts produktiv-wertvolles,
  drop+reseed der user/org/projects-Tabellen ist erlaubt.

## Effort-Total

Items 0-6 zusammen ≈ 5-6 Personentage. Die Quick-Wins (1, 2, 3) zusammen
unter einem halben Tag. Item 0 ist mit ~2d der dickste Brocken, blockt aber
nichts externes.

## Reihenfolge & Abhängigkeiten

```text
1. runner_sessions Cleanup-Cron        ─┐
2. Token-Refresh-UX                     │  (independent von 0)
3. Per-app DB user für proxy            ─┘
0. Mandatory-Org Schema Refactor       ──>┐  (foundation für 4,5,6,7)
4. Org Member Role Management          ──>│  depends on 0
5. Platform Admin Foundation           ──>│  depends on 0
6. Self-Registration via Authentik     ──>┘  depends on 5
7. Proxy-Performance lru-cache          (defer until measurable)
```

Empfehlung: 1, 2, 3 als Aufwärm-Quick-Wins (touchen kein user/org-schema).
Dann 0 als Foundation-Refactor in einem Rutsch durchziehen, weil drop+reseed
sonst zu oft passieren muss. Danach 4 + 5 in beliebiger Reihenfolge, 6 nach 5.

**Project-Transfer ist aus dem Scope** (siehe Klärung 2026-05-08): durch das
mandatory-org-Modell + memberships ist "Projekt einem anderen User geben"
implizit gelöst — beide sind Member derselben Org und haben Zugriff.
Falls später ein "primary user / project lead"-Konzept gewünscht ist, kommt
das als separates Mini-Feature.

---

## 0. Mandatory-Org Schema Refactor *(Foundation)*

**Entscheidungen festgehalten 2026-05-08:**
- Modell A: globale Identity, Memberships pro Org. Email global unique.
- Projects sind **immer** org-owned. Kein `owner_user_id`-Pfad mehr.
- Erste User-Action nach Self-Reg: Org anlegen. Keine Org → kein Projekt.
- Org hat genau einen `owner_user_id`, der ist nicht entfernbar; nur per
  `transfer-ownership` an einen anderen Member übertragbar (Item 4 deckt
  das mechanisch ab).
- Auf prod liegt nichts produktiv-wertvolles → drop+reseed statt Migration.

### Schema-Ziel

```text
users
  id                PK
  email             TEXT UNIQUE NOT NULL
  display_name      TEXT
  is_platform_admin BOOL NOT NULL DEFAULT false  -- gefüllt aus env in middleware
  created_at        TIMESTAMPTZ
  -- removed: alles org-scoped → in memberships

organizations
  id              PK
  slug            TEXT UNIQUE
  name            TEXT
  owner_user_id   FK users.id NOT NULL  -- immutable except via transfer-ownership
  created_at      TIMESTAMPTZ

org_memberships
  user_id   FK users.id
  org_id    FK organizations.id
  role      TEXT CHECK (role IN ('admin','member')) NOT NULL  -- 'owner' NICHT hier; impliziert
  created_at TIMESTAMPTZ
  PRIMARY KEY (user_id, org_id)

projects
  id            PK
  slug          TEXT UNIQUE  -- global-unique fürs Erste; org-scoped slugs ggf. Phase 2
  owner_org_id  FK organizations.id NOT NULL  -- mandatory
  created_at    TIMESTAMPTZ
  -- removed: owner_user_id
```

**Owner-Konzept:**
- `organizations.owner_user_id` ist die source-of-truth für "owner".
- `org_memberships`-row für den owner existiert ZUSÄTZLICH mit `role='admin'`
  (so dass die normale member-Listen-UI ihn als admin sieht; ein Sentinel
  `is_owner` brauchen wir nicht, weil `org.owner_user_id == user.id` der Check ist).
- **Guards** überall:
  - DELETE membership where user_id = org.owner_user_id → 400 "owner cannot be removed"
  - PATCH role 'admin' → 'member' where user_id = org.owner_user_id → 400 "owner stays admin"
  - DELETE org → muss prüfen ob der Aufrufende der owner ist; member/admin reicht nicht
- **Transfer-Ownership**: separater endpoint, atomar in einer Transaction
  - input: `{ newOwnerUserId }`, muss bereits Member der Org sein
  - swap: `org.owner_user_id = newOwnerUserId`, neue+alter owner-row in
    memberships beide auf `role='admin'` setzen (alter owner verliert nichts
    außer dem flag-Status, kann aber jetzt entfernt werden)

### Migrations

- `0006_drop_user_owned_projects.sql` — komplettes drop+recreate von
  `users`, `organizations`, `org_memberships`, `projects` aus dem schema.
  Auf prod: `docker exec specifyr ak-style migrate` läuft beim nächsten
  container-start, **DB einmalig leeren** vorher (`DROP DATABASE specifyr;
  CREATE DATABASE specifyr OWNER specifyr;`).
- Drizzle-Schema in [server/db/schema.ts](../../server/db/schema.ts) entsprechend
  umschreiben — alte `owner_user_id`-Spalten weg, `org_memberships` neu
  oder erweitert.

### Code-Touchpoints (zu auditen + anpassen)

- `server/api/projects.post.ts` — Create-Path muss `owner_org_id` aus dem
  Request akzeptieren (oder vom user-context default-mäßig auf seine
  active-org setzen, falls nur eine vorhanden)
- `server/api/projects.get.ts` — list filtert jetzt über `org_memberships`
- `server/api/projects/[slug]/*` — alle Endpoints müssen prüfen: ist der
  caller Member von `project.owner_org_id`?
- `server/api/me.get.ts` — zusätzlich Memberships zurückgeben (pro org:
  slug, name, role)
- `server/middleware/auth.ts` — user-upsert bleibt, ABER fügt KEINE Org auto
  hinzu (User landet ohne Membership; UI lenkt zur Onboarding-Page)
- `server/utils/org-store.ts`, `org-auth.ts` — auditen, ob noch alle
  Annahmen stimmen
- `app/composables/useMe.ts` — `me`-typ erweitern um `memberships: { orgSlug,
  role }[]` und `activeOrg`-State

### First-Login UX

- Nach erfolgreichem Login: `me.memberships.length === 0`?
  → Redirect zu `/onboarding/create-org` (forced, nicht überspringbar)
- Page rendert ein einfaches Form (org-name, slug auto-gen)
- POST `/api/orgs` (existiert) → User wird Owner + Admin → redirect zu `/`
- Sidebar bekommt Org-Switcher (auch wenn aktuell nur eine — später wichtig)

### Test-Plan

- Unit: Drizzle-Schema-Tests, Membership-Guards (owner immutable etc.)
- E2E: kompletter Onboarding-Flow (Reg → Force-Create-Org → erstes Project)
- E2E: zwei User in zwei Orgs (sieht jeder nur "seine" Sachen)
- E2E: `transfer-ownership` swappt korrekt + Vorgänger wird entfernbar

### Effort

~2d incl. Onboarding-UX. Größter Brocken im Plan, aber blockt nichts
externes — kann in Ruhe in einer Session laufen.

---

## 1. Cleanup-Cron für `runner_sessions`

**Status:** `pruneExpired()` ist implementiert in
[server/utils/runner-sessions-store.ts](../../server/utils/runner-sessions-store.ts),
wird aber nirgends regelmäßig aufgerufen.

**Implementation:**
- Nitro Plugin `server/plugins/runner-sessions-prune.ts`
- `setInterval(pruneExpired, 15 * 60 * 1000)` (15 min)
- Auf Shutdown clear-Interval
- Log: jede Ausführung mit `count` deleted rows

**Test:**
- Unit: existing tests für `pruneExpired` reichen
- E2E nicht nötig — interval-only logic ist trivial

**Effort:** ~30 min

---

## 2. Token-Refresh-UX

**Bug:** `oauth_claude.expiresAt < now` zeigt UI weiterhin "Connected", obwohl
Token in DB als expired markiert wäre. CLI refresht selbst beim nächsten run
(RW-credentials-Mount), aber das wird nicht zurück in die DB synchronisiert.

**Design:**
- Zwei Datenquellen: DB-Row (specifyr's Sicht) und `.credentials.json` auf Disk
  (CLI's Sicht). Disk gewinnt — sie reflektiert tatsächlich den letzten
  Refresh.
- **Lazy resolver:** `/api/me/llm-credentials/oauth/anthropic/[id]/status` liest
  `<dataDir>/credentials/{user|org}/<id>/.claude/.credentials.json`, parsed
  `expiresAt`, updated DB-Row falls drift, returnt frisches `{connected,
  expiresAt}`.
- UI zeigt:
  - `expiresAt > now` + file present → "Connected"
  - `expiresAt < now` + file present → "Token wird beim nächsten Run aktualisiert"
  - file missing → "Connected — re-authentication required" + Button

**Server changes:**
- `server/utils/oauth-flow.ts` (oder neuer file): `readCredentialsFromDisk(ownerKind, ownerId)`
- Bestehender status-endpoint erweitern, neue logic davorschalten
- `/api/orgs/[slug]/llm-credentials/oauth/anthropic/[id]/status.get.ts` analog

**UI changes:**
- `/settings/me/llm` Status-Komponente: 3 Zustände rendern statt 2
- `/settings/orgs/<slug>/llm` analog (read-only für non-admins)

**Test:**
- Unit: `readCredentialsFromDisk` mit fixtures (3 cases: present-valid,
  present-expired, missing)
- E2E: bestehende API-E2E erweitern um expired-state

**Effort:** ~2-3h

---

## 3. Per-app DB user für `haex-claude-proxy`

**Pattern wie authentik:** dedizierter `haex_claude_proxy` PG-Rolle, nur
SELECT auf `runner_sessions` + USAGE auf der Sequence.

**Ansible (`roles/haex-claude-proxy/tasks/main.yml`):**
```yaml
- name: Check if haex-claude-proxy postgres role exists
  # exact mirror of authentik role check, mit
  # secrets.postgres.haex_claude_proxy.{user,password}

- name: Create haex-claude-proxy postgres role (LOGIN, no superuser)

- name: Sync password (idempotent)

- name: Grant SELECT on runner_sessions
  cmd: docker exec postgres psql -U postgres -d specifyr -c
       "GRANT CONNECT ON DATABASE specifyr TO haex_claude_proxy;
        GRANT USAGE ON SCHEMA public TO haex_claude_proxy;
        GRANT SELECT ON runner_sessions TO haex_claude_proxy;
        GRANT UPDATE (last_used_at) ON runner_sessions TO haex_claude_proxy;"
```

**Wichtig:** Proxy macht ggf. UPDATE auf `last_used_at` für Telemetrie — check
[haex-claude-proxy/src/auth.js](../../../haex-claude-proxy/src/auth.js)
welche statements der proxy genau abfeuert. Falls nur SELECT: SELECT-only.

**Compose-template (`roles/haex-claude-proxy/templates/docker-compose.yml.j2`):**
- `DATABASE_URL: postgresql://{{ secrets.postgres.haex_claude_proxy.user }}:{{ secrets.postgres.haex_claude_proxy.password | urlencode }}@postgres:5432/specifyr`

**secrets.example.yml:**
- Neuer Block `secrets.postgres.haex_claude_proxy.{user,password}`

**Migration auf prod:**
1. PR mit allen Tasks + neuer DATABASE_URL
2. `secrets.yml` auf prod manuell um neuen User-Block erweitern
3. `ansible-playbook --tags haex-claude-proxy` → role wird angelegt + grants
   gesetzt + container recreated mit neuer DATABASE_URL
4. Smoke: `docker logs haex-claude-proxy --tail 20` muss "listening on..."
   zeigen, kein 503 bei requests

**Risiko:** GRANT-Scope falsch → proxy 503's. Rollback: alter DATABASE_URL
zurück auf `postgres:Fingerweg666`-creds, `--tags haex-claude-proxy` neu.

**Effort:** ~3-4h incl. testing

---

## 4. Org Member Role Management + Owner-Transfer

**Setzt Item 0 voraus** (memberships-schema mit clean role-enum, owner-flag
implizit über `organizations.owner_user_id`).

### Server-Endpoints

- **PATCH `/api/orgs/[slug]/members/[userId]/role`**
  - Body: `{ role: 'admin' | 'member' }`
  - Auth: caller muss admin (oder owner) in der Org sein
  - Guards:
    - Cannot demote self if last admin → 400 "would orphan org"
    - Cannot demote `org.owner_user_id` → 400 "owner stays admin"
    - Idempotent (PATCH zu derselben role: 200 no-op)

- **DELETE `/api/orgs/[slug]/members/[userId]`**
  - Auth: caller muss admin
  - Guards:
    - Cannot remove `org.owner_user_id` → 400 "owner cannot be removed; transfer ownership first"
    - Cannot remove self if last admin → 400 (empfehle: über transfer-ownership oder via platform-admin)

- **POST `/api/orgs/[slug]/transfer-ownership`** *(neu)*
  - Body: `{ newOwnerUserId }`
  - Auth: caller muss `org.owner_user_id` sein (nicht nur admin!)
  - Guards:
    - `newOwnerUserId` muss bereits Member der Org sein → 400 "must be member"
  - Atomic in einer Transaction:
    - `org.owner_user_id = newOwnerUserId`
    - upsert membership row für newOwner mit `role='admin'`
    - upsert membership row für alten Owner mit `role='admin'`  (verliert nichts außer dem owner-flag)
  - Nach Erfolg ist alter Owner ein normaler admin, kann anschließend per
    DELETE oder demote-PATCH bearbeitet werden.

### UI

- `/settings/orgs/<slug>/members` (existiert per Phase 9)
  - Pro Row: Role-Badge ("Owner" wenn `org.owner_user_id`, sonst "Admin"/"Member")
  - Action-Menu (admin-only): Promote / Demote / Remove
  - Owner-row hat Action-Menu disabled, mit Tooltip "Transfer ownership first"
- `/settings/orgs/<slug>/danger-zone` (neu oder existing settings-Seite erweitern)
  - Owner-only: "Transfer ownership"-Button
  - Modal mit Member-Dropdown + Confirmation ("Du verlierst danach Owner-Rechte, …")

### Test

- Unit: Guards einzeln (last admin, owner immutable, must-be-member-of-org)
- E2E: Promote → Demote roundtrip
- E2E: Remove member (ohne owner-Status) succeeds
- E2E: Remove owner blocked → transfer → Remove ex-owner succeeds

**Effort:** ~5-6h (mehr als ursprünglich, weil transfer-ownership dazukommt)

---

## 5. Platform Admin Foundation + Settings UI

**Konzept:** Eine User mit `is_platform_admin = true` kann das ganze
specifyr-Setup managen, unabhängig von org-Membership. Trennung von
org-admin (scoped) und platform-admin (global).

**Gating:**
- Empfehlung: ENV var `SPECIFYR_PLATFORM_ADMIN_EMAILS=email1@x.de,email2@y.de`
  - Middleware lesen: bei user-upsert `is_platform_admin = email in list`
  - Vorteil: kein Schema-Change nötig für rollout, easy via inventory
  - Alternative: DB-column + UI zum togglen — overengineered für jetzt
- DB: Spalte `users.is_platform_admin` ist via Item 0 schon im Schema; hier
  nur befüllen via middleware. Phase 2 (DB-driven flag mit UI-Toggle) bleibt
  optional, wenn der Bedarf da ist.

**Routes / pages:**
- `/admin/` — landing, redirect zu /admin/users
- `/admin/users` — Tabelle aller user (id, email, displayName, createdAt,
  last_seen optional, count of orgs)
- `/admin/orgs` — Tabelle aller orgs (slug, name, owner, member-count,
  project-count, createdAt)
- `/admin/settings/registration` — Self-Registration-Policy (siehe Item 6)

**Middleware:**
- `app/middleware/platform-admin.ts` (route middleware): redirect zu / falls
  `!is_platform_admin`
- `server/middleware/platform-admin.ts` (server): 403 auf `/api/admin/*` falls
  nicht platform-admin

**Server endpoints:**
- `GET /api/admin/users` — paginated list (default 50)
- `GET /api/admin/orgs` — paginated list
- `GET /api/admin/settings` — current settings
- `PATCH /api/admin/settings` — update settings (registration policy)

**Settings-Storage:**
- Tabelle `platform_settings` (key TEXT PRIMARY KEY, value JSONB,
  updated_at, updated_by_user_id)
- Migration: `0007_platform_settings.sql` (nach Item 0's 0006)
- Initial keys:
  - `registration.policy` (string: `open` / `domain` / `closed`)
  - `registration.allowed_domains` (string[])
- Helper: `getSetting(key, default)` / `setSetting(key, value, userId)`

**Test:**
- Unit: middleware gating (allow vs deny)
- E2E: `/api/admin/*` als platform-admin vs. normal user (200 vs 403)
- E2E: settings PATCH propagiert in GET

**Effort:** ~1-1.5d (foundation + minimum-viable UI)

---

## 6. Self-Registration via Authentik

**Voraussetzung:** Item 5 ist drin (settings table + admin UI für policy).

**Wie self-reg in authentik aktiviert wird:**
- Authentik default-authentication-flow hat einen optionalen "enrollment_flow"
- Existing blueprint shipps bereits `default-source-enrollment-flow`
- Identification-Stage hat ein Feld `enrollment_flow: !KeyOf default-source-enrollment-flow`
- → in `roles/authentik/templates/blueprints/specifyr-proxy.yaml.j2` (oder
  neuer blueprint) den enrollment-flow auf der identification-stage setzen

**Domain-restriction:**
- Empfehlung: in **specifyr** prüfen, nicht authentik
- Authentik kennt das specifyr-policy-table nicht. Wenn wir das in authentik
  spiegeln (Expression Policy mit `request.user.email.endsWith(...)`), haben
  wir doppelte source-of-truth.
- Stattdessen: bei user-upsert in [server/middleware/auth.ts](../../server/middleware/auth.ts)
  vor INSERT prüfen:
  ```ts
  const policy = await getSetting('registration.policy', 'closed');
  const allowed = await getSetting('registration.allowed_domains', []);

  if (policy === 'closed' && !existingUser) {
    // Reject creation. Existing users still log in.
    throw createError({ statusCode: 403, statusMessage: 'Registration disabled' });
  }
  if (policy === 'domain' && !existingUser && !allowed.includes(domainOf(email))) {
    throw createError({ statusCode: 403, statusMessage: 'Email domain not permitted' });
  }
  ```
- User sieht im browser nach authentik-login eine 403-Page von specifyr
  (specifyr's eigene 403-route stylen für Klarheit)

**Org-Invite-Flow bleibt:** auch bei `closed` policy kann ein org-admin via
Invite einen externen User einladen. Diese Invite-Acceptance erstellt einen
specifyr-User und bypassed die policy (per design).

**Test:**
- E2E: 3 cases — closed (deny), domain (deny+allow), open (allow always)
- E2E: invite-flow ignoriert policy

**Effort:** ~3-4h

---

## 7. Proxy-Performance lru-cache (deferred)

In [haex-claude-proxy/src/auth.js](../../../haex-claude-proxy/src/auth.js)
`createDbLookup` mit lru-cache (5min TTL, key=token) wrappen.

Defer bis: messbare Latenz oder DB-load-Issue auftritt. Aktuell auf prod
single-user, also irrelevant.

---

## Quick-Start für die nächste Session

```bash
# State-Check
gh pr list --repo haexhub/ansible --state merged --limit 5  # bis #11
gh pr list --repo haexhub/specifyr --state merged --limit 5
gh pr list --repo haexhub/haex-claude-proxy --state merged --limit 3

# Smoke
ssh haex.cloud "docker ps --filter name=specifyr --filter name=haex-claude-proxy --filter name=authentik"
curl -sk -w '%{http_code}\n' -o /dev/null https://specifyr.haex.cloud/  # erwartet 302
```

## Pitfalls aus dieser Session, die weitergelten

- `gh auth switch --user haexhub` vor jedem `gh` auf haexhub-repos.
  Active-Account flippt manchmal auf `haex-space`.
- Ansible Edits: feature branch + PR, kein direkter master-push.
- Authentik blueprints: `state: created` → re-apply triggert nicht von selbst.
  Wenn Schema/Inhalt geändert wird, manuell `last_applied_hash=""` + `apply_blueprint.delay()` via `ak shell`.
- Authentik first-boot: Migrationen brauchen ~3min; healthcheck `start_period`
  ist auf 300s. Bei `up -d` Geduld haben oder server-only starten.
- Auf prod gilt: nichts produktiv-Wertvolles in der DB, daher dürfen die
  Aufräum-Pfade aggressiv sein (DB drop-and-recreate ist immer noch ok bis
  echte User da sind).
