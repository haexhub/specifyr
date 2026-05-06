# Multi-Tenant User & LLM Provider Management

**Status:** Draft v2 — supersedes single-user version of the same date
**Author:** mdrechsel@itemis.com
**Date:** 2026-05-06

## Goal

Turn specifyr from a single-user local tool into a multi-tenant
self-hosted app on haex.cloud. Concretely:

- **Users**, identified by Authelia (already in the stack), persisted in
  Postgres (also in the stack).
- **Organizations** with members and roles (`admin`, `member`).
- **LLM credentials** scoped at two levels: user-personal AND
  org-shared. Members of an org can use org credentials by default, can
  optionally override with their own.
- **Claude OAuth (Pro/Max)** per user and per org, with concurrent use
  by multiple sessions without cross-user interference.

Out of today's behavior (env-var-driven, single shared Anthropic key)
this is a substantial expansion — but every piece replaces something
that doesn't scale past one user.

## What gets touched

| Layer | Today | After |
|---|---|---|
| Auth | None | Authelia forward-auth, trust-headers in specifyr |
| Identity | None | `users` table in Postgres, mirrored from Authelia identity |
| Project ownership | filesystem dir under `<dataDir>/.specifyr/<slug>/`, no owner | `projects` table (owner = user or org) |
| Org model | None | `orgs` + `org_memberships` tables |
| LLM credentials | `process.env.ANTHROPIC_API_KEY` + `runtimeConfig` | `llm_credentials` table, AES-256-GCM encrypted |
| Claude OAuth | one shared `~/.claude/` in `haex-claude-proxy` container | per-owner `<dataDir>/credentials/{user\|org}/<id>/.claude/`, runners read via `CLAUDE_HOME` |
| `haex-claude-proxy` role | sole gateway to Claude Pro/Max | optional, only for external HTTP clients — specifyr internal path no longer goes through it |

## Architecture

### Auth flow

```
Browser ─► traefik ─► authelia (forward-auth) ─► specifyr
                          │
                          └─ injects Remote-User, Remote-Email, Remote-Groups headers
specifyr
  on every request:
    1. read Remote-Email
    2. SELECT/UPSERT users WHERE email = ?
    3. attach userId to event.context
    4. (optional) attach orgIds via memberships
```

Authelia handles login, MFA, password reset, password storage. specifyr
does not implement its own login — only consumes trusted headers.

`specifyr.use_authelia: true` is already configured in
[ansible inventory](../../../ansible/inventory/haex.cloud.yml). The
forward-auth middleware is already wired in
[docker-compose template](../../../ansible/roles/specifyr/templates/docker-compose.yml.j2#L60).
What's missing: the server-side header consumer.

### Database schema (Postgres)

```sql
-- Mirror of Authelia identity. Created on first request.
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text UNIQUE NOT NULL,    -- lowered, trim'd
  display_name text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,    -- url-safe, e.g. "itemis"
  name        text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_memberships (
  org_id     uuid REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- Existing filesystem projects get migrated into this table.
CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,    -- matches existing on-disk dir
  owner_kind  text NOT NULL CHECK (owner_kind IN ('user', 'org')),
  owner_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX projects_owner_idx ON projects (owner_kind, owner_id);

-- Polymorphic credential bag. owner = user OR org.
CREATE TABLE llm_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind      text NOT NULL CHECK (owner_kind IN ('user', 'org')),
  owner_id        uuid NOT NULL,

  provider        text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
  mode            text NOT NULL CHECK (mode IN ('api_key', 'oauth_claude')),
  display_name    text NOT NULL,         -- "Personal", "Team Shared", etc.

  -- api_key mode: encrypted blob (AES-256-GCM). NULL for oauth_claude.
  api_key_iv      bytea,
  api_key_tag     bytea,
  api_key_data    bytea,

  -- oauth_claude mode: status of the on-disk credentials file.
  -- Actual tokens live at <dataDir>/credentials/<owner_kind>/<owner_id>/.claude/
  -- specifyr never decrypts/reads them directly — `claude` CLI does.
  oauth_status         text CHECK (oauth_status IN ('pending', 'authorized', 'expired')),
  oauth_authorized_at  timestamptz,

  base_url        text,                  -- override (e.g. self-hosted endpoints)
  default_model   text,
  enabled         boolean NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (owner_kind, owner_id, provider, display_name)
);

CREATE INDEX llm_credentials_owner_idx
  ON llm_credentials (owner_kind, owner_id, provider, enabled);
```

DDL lives in [server/db/migrations/](../../server/db/migrations/) (new
dir). Plain SQL files run in lex order at boot via a tiny migrator
(20 lines, no ORM). The `postgres` role is already in the playbook —
add a `specifyr` database to its init.

### Credential resolution

When a runner needs to talk to provider P (e.g. `anthropic`) for a
session in project `slug` started by user U:

```
1. project = SELECT * FROM projects WHERE slug = ?
2. project.owner_kind = 'org' → ownerOrg = projects.owner_id
                              → require U is member of ownerOrg
   project.owner_kind = 'user' → require U == projects.owner_id

3. candidates =
     [ ...credsForOwner('user', U.id, P, enabled=true)
     , ...(ownerOrg ? credsForOwner('org', ownerOrg, P, enabled=true) : [])
     ]
   (user-personal first, org-shared as fallback)

4. if candidates.length === 0: 4xx "no credentials configured"
5. if candidates.length === 1: use it
6. else: pick the first (user can later set a "default" flag per provider
   if the multi-credential UX matters; defer until needed)
```

### OAuth Claude flow

The challenge: `claude` CLI authenticates against ONE
`$CLAUDE_HOME/credentials.json`. Multiple parallel users with
different Anthropic accounts must not stomp each other.

**Solution:** per-owner CLAUDE_HOME directories.

```
<dataDir>/credentials/
├── user/
│   ├── <userId-A>/.claude/credentials.json
│   ├── <userId-B>/.claude/credentials.json
│   └── ...
└── org/
    ├── <orgId-X>/.claude/credentials.json   ← shared by all members of X
    └── ...
```

Each runner spawn sets `CLAUDE_HOME=<the chosen dir>` based on the
resolution above. Concurrent sessions from different users hit
different files — no interference. Concurrent sessions within ONE org
share one credentials.json read-only; the only risk is the CLI
refreshing the token (writes the file). Mitigation: the credentials
file is only re-written on token expiry, which the CLI does atomically
(temp file + rename). For belt-and-braces we'll add a per-owner mutex
in node, not relevant in v1.

**Login flow:**

```
[Settings UI: "Login with Claude" on credential row]
  │
  ▼
POST /api/me/credentials/<credId>/oauth/start
  server:
    1. resolve credId → owner (must match current user OR user must be admin of owner-org)
    2. dir = <dataDir>/credentials/<ownerKind>/<ownerId>/.claude/
    3. spawn `claude auth login` with CLAUDE_HOME=dir, capture stdout
    4. parse OAuth URL from stdout
    5. UPSERT llm_credentials.oauth_status = 'pending'
    6. return { loginUrl, sessionId }
  │
  ▼
[Frontend opens loginUrl in new tab]
  │
  ▼
[User authorizes on anthropic.com → CLI subprocess receives token,
 writes credentials.json, exits 0]
  │
  ▼
[Frontend polls GET /api/me/credentials/<credId>/oauth/status every 2s]
  server:
    - check credentials.json exists & valid → set oauth_status='authorized', return it
  │
  ▼
[UI badge flips to "Authorized • <expiry>"]
```

### Runner integration

Replace
[start.post.ts:194-225](../../server/api/projects/%5Bslug%5D/company/start.post.ts#L194-L225)
with:

```ts
const userId = event.context.userId            // set by auth middleware
const project = await loadProject(slug)
ensureUserCanAccess(userId, project)           // throws 403 otherwise

const cred = await resolveCredential({ userId, project, provider: "anthropic" })

const env: Record<string, string> = {}
if (cred.mode === "api_key") {
  env.ANTHROPIC_API_KEY = decryptKey(cred)
  if (cred.base_url) env.ANTHROPIC_BASE_URL = cred.base_url
} else if (cred.mode === "oauth_claude") {
  env.CLAUDE_HOME = oauthDirFor(cred)          // <dataDir>/credentials/...
  // claude-code / hermes / acp runners pick this up directly. No proxy in path.
}
```

Same shape per-provider for OpenAI/Google once those runners are added.

### Frontend

Three settings surfaces, gated by role:

| Surface | Path | Visible to |
|---|---|---|
| Personal LLM credentials | `/settings/me/llm` | Every user |
| Org settings (members, LLM credentials) | `/settings/orgs/<slug>` | Org members; "edit" only for `admin` role |
| System admin (provider whitelist, default models, instance-wide flags) | `/settings/admin` | Users in Authelia group `specifyr-admins` |

Components reused from existing shadcn-vue scaffold; layout
`app/layouts/settings.vue` adds a left rail with the three surfaces
filtered by permission.

## Phases & shippable increments

Each phase is independently mergeable + deployable; the system stays
functional after every phase.

| # | Scope | Effort | Notes |
|---|---|---|---|
| **0** | Postgres in playbook (already exists in roles, add `specifyr` DB), Authelia user list provisioning, app-level pg client (`pg` package), migration runner | 0.5d | Prereq for everything that follows |
| **1** | `users` table + auth middleware (consume Authelia headers, UPSERT user), basic `/api/me` endpoint, attach `userId` to event context everywhere | 1d | After this, the app "knows" who's making requests but behavior unchanged |
| **2** | `projects` table + ownership; migrate existing filesystem projects to user-owned for the bootstrap admin; project access guards | 1d | Each existing project gets owned by the admin (you) — no data loss |
| **3** | `orgs` + `org_memberships` tables, org create/list/invite endpoints, basic UI under `/settings/orgs/...`, ability to transfer a project to an org | 1.5d | Now we have multi-tenant scaffolding |
| **4** | `llm_credentials` table + encrypted store reusing master-key pattern, CRUD API, personal credential UI at `/settings/me/llm` (api_key only) | 1d | Personal API-key path works end-to-end |
| **5** | Org credential UI at `/settings/orgs/<slug>/llm`, resolution logic in runner factory | 0.5d | Members can use org keys |
| **6** | OAuth Claude flow: subprocess management, status polling endpoint, login UI for personal credentials | 1.5d | Per-user OAuth |
| **7** | Same OAuth flow at org level (admin-only initiates, all members consume) | 0.5d | Per-org OAuth |
| **8** | (optional) System-admin surface for provider whitelist + default model | 0.5d | Polish |

**Total:** ~7-8 days of focused work. Phases 0-2 deliver no user-visible
features but unblock everything; phases 3-7 are the bulk.

## Open questions before starting

1. **Authelia ↔ specifyr identity binding**: today Authelia's user DB
   stores `email`. Is this guaranteed unique and stable? (Renaming an
   email would orphan all the user's data.) Standard pattern is to
   carry an immutable `sub` claim instead — but Authelia's
   forward-auth headers don't include one out of the box. Do we want
   to risk email-as-key, or extend Authelia's config to expose a UUID?

2. **First-org bootstrap**: who creates the first org? Options:
   - CLI command on the server (`specifyr admin org-create itemis`)
   - First user with email in `SPECIFYR_ADMIN_EMAILS` env var becomes a
     system admin and can create orgs from the UI
   - Self-service: every user can create an org and is automatically
     admin of it

3. **Project ownership migration**: existing on-disk projects (`<dataDir>/.specifyr/<slug>/`)
   need an owner. Default everyone to a single bootstrap user, or have
   the migration prompt? Suggest: env var `SPECIFYR_BOOTSTRAP_USER_EMAIL`,
   migrate-to-that-user on first boot if non-empty.

4. **Credential precedence under multi-org membership**: a user belongs
   to org A and org B. Project P is owned by org A. User U has
   personal creds + org-A creds + org-B creds. Spec above uses
   user→project-owner only — org-B's creds are unreachable for project P.
   Confirm this is desired.

5. **`haex-claude-proxy` future**: deprecate from the playbook, or keep
   as an opt-in HTTP gateway for non-specifyr consumers? My
   recommendation: keep but stop using it from specifyr.

6. **Postgres operational concerns**: backups (you already have this for
   the existing postgres role?), connection pooling (pg.Pool with N=10
   should suffice for a single-instance setup), schema migrations
   (manual SQL files — no Prisma/Drizzle/Kysely). OK?

7. **Encryption key rotation**: master key is derived from
   `SPECIFYR_SECRET_KEY` env or `<dataDir>/master.key`. With many users
   storing credentials, rotation becomes a thing — out of scope for v1
   but worth noting.

## What's deliberately out of scope

- Billing / quota tracking per user / per org
- Cost reporting
- Self-service signup (Authelia handles this if enabled)
- Audit log of credential use (could be added cheaply later)
- Webhook / API for external CI to use specifyr-managed credentials
- Multi-region / HA

These are real but distinct from "make multi-user work."
