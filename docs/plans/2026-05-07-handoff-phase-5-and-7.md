# Handoff: Phase 5 + Phase 6/7

**Status:** Ready for execution in a fresh session
**Date:** 2026-05-07
**Predecessor plan:** [2026-05-06-llm-provider-settings.md](./2026-05-06-llm-provider-settings.md) (v3, accepted)

This document captures everything the next session needs to pick up
without re-deriving context from chat history.

## What's already shipped

Phases 0–4 + the runner integration are live on `main`. End-to-end
deploy loop works (release-please → tag → build → watchtower).

| Phase | Outcome | Key files |
|---|---|---|
| 0 | Drizzle + pg, optional at boot | `server/db/{client,schema,migrations}.ts`, `server/plugins/db.ts` |
| 1 | `users` table + Authelia/Authentik header middleware | `server/db/schema.ts`, `server/middleware/auth.ts`, `server/api/me.get.ts` |
| 2 | `projects` table + DB-tracked ownership | `server/db/schema.ts`, `server/utils/project-store.ts`, `server/api/projects.{post,get}.ts` |
| 3 | `orgs` + `org_memberships` + `org_invites` + Settings UI | `server/db/schema.ts`, `server/utils/org-store.ts`, `server/api/orgs/`, `server/api/invites/`, `app/pages/settings/orgs/`, `app/pages/invites/[token].vue` |
| 4 | `llm_credentials` (encrypted), CRUD API + UI, OpenRouter | `server/db/schema.ts`, `server/utils/llm-credentials-store.ts`, `server/api/me/llm-credentials/`, `app/pages/settings/me/llm.vue` |
| Runner integration | User-personal Anthropic key auto-injected into agent env | `server/api/projects/[slug]/company/start.post.ts` (lines ~185–260) |

**Auth:** Authentik replaced Authelia (PR #7 in ansible repo merged).
Forward-auth in traefik via `authentik@docker` middleware. Specifyr
auth middleware reads both `X-authentik-*` and legacy `Remote-*`
headers. Dev-mode loop works via `SPECIFYR_DEV_USER_EMAIL` +
`/api/dev/{login,logout}` cookie suppression.

**Infra:** Postgres on haex.cloud serves both `specifyr` and
`authentik` databases. Existing `pgadmin` UI is reachable but
gated only by its own login (no Authentik in front — user choice).

## Outstanding architecture decisions

Locked in already; do NOT re-debate:

- ✅ Email as identity key (Authentik `Remote-Email` / `X-authentik-email`)
- ✅ Self-service org creation, admin-driven invitations
- ✅ Drizzle ORM (no raw SQL files, no Prisma)
- ✅ Authentik (no LLDAP, no Supabase, no Keycloak)
- ✅ haex-claude-proxy stays — refactored to be session-token-aware
- ✅ Multi-org credential precedence: user-personal > project-owner-org. Other orgs the user belongs to are not used for that project.
- ✅ Default-model field is gone from llm_credentials (agents pick model per-run)

## Phase 5 — Org-shared LLM credentials

**Goal:** Org admins can add credentials at the org level; members
without their own personal credential fall back to the org's.

### Schema — already in place

The `llm_credentials` table is polymorphic: `(owner_kind, owner_id)`
already supports `'org'` values. No DDL change needed for Phase 5.
Just add API + UI + resolver fallback.

### API surface

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/orgs/:slug/llm-credentials` | Members can read; admins can edit. List the org's credentials. |
| `POST` | `/api/orgs/:slug/llm-credentials` | Admin-only. Same body shape as `/api/me/llm-credentials`. |
| `PATCH` | `/api/orgs/:slug/llm-credentials/:id` | Admin-only. |
| `DELETE` | `/api/orgs/:slug/llm-credentials/:id` | Admin-only. |

Permission helper: `getMembership(orgId, userId)` already exists in
`server/utils/org-store.ts`. Wrap each endpoint with the same admin
check pattern as `server/api/orgs/[slug]/invites.post.ts`.

The `llm-credentials-store.ts` already has helpers that take an
`ownerKind`/`ownerId` pair — no new store code needed for CRUD,
just thin route handlers.

### Resolver fallback

Update `resolveCredentialForUser(userId, provider)` to also try
org-owned credentials when no user-personal hit:

```ts
// new signature:
export async function resolveCredentialForRequest(
  userId: string,
  ownerOrgId: string | null,   // project's owner org, if project is org-owned
  provider: Provider,
): Promise<ResolvedCredential | null>
```

Resolution order:
1. User-personal enabled credential (current behaviour)
2. If `ownerOrgId` is set: org-owned enabled credential
3. null (caller falls back to legacy proxy / runtimeConfig path)

Then `start.post.ts` needs the project's owner org. Add
`projects` table → join. Currently `projects.owner_kind` is `'user'`
for everything created since Phase 2. Phase 5 should also add a UI
to "transfer project to org" (or, simpler, pick org at creation time).

### UI

New page `app/pages/settings/orgs/[slug]/llm.vue`. Reuse the provider
card layout from `app/pages/settings/me/llm.vue` — extract the form
into a `LlmCredentialCard.vue` component first to avoid duplication.

Surface visibility:
- Members: read-only list
- Admins: same buttons as the personal page (Add / Enable / Disable / Delete)

Add a link to `/settings/orgs/[slug]/llm` from the org detail page
(`app/pages/settings/orgs/[slug].vue`).

### Project ownership UX (small subtask)

Today every project created via `POST /api/projects` is owned by the
caller (`{ kind: 'user', id: userId }`). For org-owned credentials to
matter, projects need to be assignable to an org. Two options:

- (A) Project creation form: org dropdown ("Personal" + each org you're a member of). Owner set at create-time.
- (B) Defer; do "Transfer ownership" UI later. v1 only resolves user-personal.

**Recommend (A)** — small UI change, covers the use case immediately.
Backend: `recordProjectOwnership` already accepts the polymorphic
owner; just thread the choice through the API.

### Effort estimate

- API endpoints: 0.25d
- Resolver update + start.post.ts integration: 0.25d
- UI (page + extracted card component): 0.5d
- Project owner-org selection: 0.25d

**Total: ~1.25d**

## Phase 6 + 7 — Multi-tenant claude-proxy + Per-user OAuth

This is the cross-repo work. **Different repo:**
[haexhub/haex-claude-proxy](https://github.com/haexhub/haex-claude-proxy)
on haex.cloud at `/home/haex/Projekte/haex-claude-proxy`.

### Why it exists

The `hermes-agent` containers spawned by specifyr run in their own
Docker namespace and can't read host filesystem paths. They talk
HTTP to a sidecar (`haex-claude-proxy`) which holds the Claude CLI's
OAuth token in `~/.claude/credentials.json` and forwards requests to
api.anthropic.com. Today: ONE proxy = ONE OAuth account, shared
across all users (single-tenant assumption).

Multi-tenant: per-request, the proxy spawns the `claude` CLI
subprocess with `HOME=<owner-specific-dir>` so each user/org's
credentials.json is read independently. **One container, many
subprocesses, no per-user containers.** Concurrent claude-CLI
spawns isolate via `HOME` — see the diagram in
[2026-05-06-llm-provider-settings.md](./2026-05-06-llm-provider-settings.md#proxy-multi-tenant).

### Phase 6 — Session-token plumbing in specifyr

Adds the runtime-side token store that the proxy resolves at
request-time.

**Schema:**

```sql
CREATE TABLE runner_sessions (
  token       text PRIMARY KEY,                      -- random 32-byte hex
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_kind  text NOT NULL CHECK (owner_kind IN ('user', 'org')),
  owner_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX runner_sessions_user_idx ON runner_sessions (user_id, expires_at);
```

**Wire in `start.post.ts`:**

When the session resolves to OAuth-Claude (i.e. `mode='oauth_claude'`,
not `api_key`), instead of injecting `ANTHROPIC_API_KEY=<plaintext>`,
mint a session token, store it, and inject:

```
ANTHROPIC_BASE_URL=http://haex-claude-proxy:8080
ANTHROPIC_API_KEY=<sessionToken>      # the token IS the API-key from the agent's POV
```

The agent doesn't know the difference. The proxy uses the API-key
field as a session-token resolver (next phase).

**Effort:** 0.5d.

### Phase 7 — Multi-tenant claude-proxy

In `/home/haex/Projekte/haex-claude-proxy`. Current code:
`src/server.js` ~270 LoC.

**Changes:**

1. Read `Authorization: Bearer <token>` (or `x-api-key`, depending on
   what hermes sends — verify by curl-ing the existing hermes-agent
   container).
2. Look up the token in specifyr's `runner_sessions` table — direct
   pg connection sharing the same `DATABASE_URL`. Resolve to
   `(owner_kind, owner_id)`.
3. Spawn the `claude` CLI subprocess with
   `HOME=/credentials/<owner_kind>/<owner_id>` instead of the current
   process-level `HOME`.
4. The credentials directory layout:
   ```
   /credentials/user/<userId>/.claude/credentials.json
   /credentials/org/<orgId>/.claude/credentials.json
   ```
   These are bind-mounted from the host
   `<app_dir>/specifyr/credentials/` (writable so the CLI can refresh
   tokens — atomic file rename, low race-risk in practice).

**Ansible work:**
- Update `roles/haex-claude-proxy/`'s docker-compose to bind-mount
  the credentials directory and add the `DATABASE_URL` env var.
- Update `roles/specifyr/` so its docker-compose creates the same
  `<app_dir>/specifyr/credentials/` dir and bind-mounts it
  read-write into specifyr too (specifyr writes the credentials file
  during the OAuth flow in Phase 8; proxy reads it).

**Effort:** 1d (across both repos).

### Phase 8 — Personal Claude OAuth flow (deferred)

Once Phase 7 lands, add the OAuth-login button to the Personal LLM
credentials UI. The flow:

1. User clicks "Login with Claude" on `/settings/me/llm`
2. POST `/api/me/credentials/oauth/anthropic/start`
3. Server creates the per-user dir + spawns `claude auth login` with
   that `HOME` set, parses the OAuth URL from stdout
4. Returns the URL to the frontend
5. Frontend opens the URL in a new tab; the user authorizes
6. CLI writes credentials.json on completion
7. Frontend polls `/api/me/credentials/oauth/anthropic/status` every 2s
8. Server returns "authorized" once the file exists with a valid
   `expires_at`

**Effort:** 1d.

### Phase 9 — Org-level Claude OAuth (after 8)

Same flow at the org level, admin-only. Phase 8's code generalises
trivially — just pass `(ownerKind, ownerId)` instead of always user.
**Effort:** 0.25d.

## Recommended next-session sequence

1. **Phase 5** (~1.25d) — biggest visible win, all single-repo.
2. **Phase 6** (~0.5d) — small specifyr change, prerequisite for Phase 7.
3. **Phase 7** (~1d) — cross-repo, requires running the proxy refactor + ansible bumps + a fresh deploy. Test path: existing user with API-key cred should keep working; OAuth user gets routed through new path.
4. **Phase 8 + 9** (~1.25d) — UX polish; the OAuth subprocess management is the only tricky bit.

**Total remaining for full multi-tenant LLM auth:** ~4 days.

## Pitfalls to watch in the next session

- **Auto-compaction may have summarised away** specifics of the
  Authentik blueprint shape, the release-please workflow_dispatch
  chain, and the test-postgres setup. Re-derive from these files
  if needed:
  - Auth blueprint: `/home/haex/Projekte/ansible/roles/authentik/templates/blueprints/specifyr-proxy.yaml.j2`
  - Release-please: `.release-please-config.json`, `.github/workflows/release-please.yml`
  - Local pg snippet: in `.env.example`
- **Ansible edits don't push directly to master** — feature branch + PR is required. The hook will block direct master pushes.
- **`gh auth switch --user haexhub`** is needed before merging release PRs (the active default account is `haex-space`).
- **Watchtower polls every 5min**; force a check with `ssh haex.cloud "docker kill -s USR1 watchtower"` after an image push.
- **Phase 5 credential card** should be extracted as a component on
  the way in — both `/settings/me/llm` and
  `/settings/orgs/<slug>/llm` will use it. Don't duplicate.

## Quick-start incantations for the next session

```bash
# Local dev:
docker run -d --rm --name pg -p 5566:5432 \
  -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=specifyr postgres:alpine
pnpm dev   # reads .env (DATABASE_URL, SPECIFYR_DEV_USER_EMAIL, SPECIFYR_SECRET_KEY)

# Production deploy after a release PR is merged:
gh auth switch --user haexhub
gh pr merge <N> --repo haexhub/specifyr --squash --delete-branch
# Watch the v0.X.0 build: gh run list --repo haexhub/specifyr --limit 3 --workflow "Build specifyr image"
ssh haex.cloud "docker kill -s USR1 watchtower"   # force watchtower poll

# Ansible deploy (use feature branch + PR):
cd /home/haex/Projekte/ansible
git checkout -b feat/<topic>
# ... edits ...
git push origin feat/<topic>
gh pr create --base master --title "..." --body "..."
ansible-playbook -i inventory/haex.cloud.yml haex.cloud.play.yml --tags <role>
```

## Open questions for the next session to surface back

These are deliberately deferred — flag them when they become real.

- **Self-registration via Authentik**: today only akadmin can create
  users. Authentik supports a self-registration flow; we punted on
  configuring the blueprint for it. Surface again when we want to
  open the platform to invite-driven signups (companion to the
  org-invite flow already shipped).
- **Stripe / billing integration**: Phase B in the SaaS roadmap, not
  yet planned in detail. Probably its own document when it's time.
- **Project transfer between orgs**: Phase 5 covers create-time owner
  selection; transfer-after-the-fact is a separate UI sprint.
