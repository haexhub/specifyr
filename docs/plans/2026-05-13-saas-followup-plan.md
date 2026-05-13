# SaaS-Hardening Follow-up Plan

> Status: living document — created 2026-05-13 after the first hardening
> wave (specifyr #46–49, #51 and haex-claude-proxy#3).
> Source of truth for which follow-up to pick next.

This plan picks up where [SAAS_ROADMAP.md](../SAAS_ROADMAP.md) and
[THREAT_MODEL.md](../THREAT_MODEL.md) leave off. Read both before
starting any item below.

## Where we stand (post first wave)

Done:
- Threat model + roadmap committed (#47)
- Per-agent quotas (cpus/memory/pids-limit/nofile) + per-company docker
  bridge `co-<slug>` (#48)
- Proxy reads encrypted oauth credentials from DB, decrypts in-process,
  stages plaintext into ephemeral tmpfs HOME, encrypts refreshed tokens
  back. Postgres RLS on `llm_credentials` actually enforced (proxy
  authenticates as `haex_claude_proxy` role) (haex-claude-proxy#3,
  specifyr#49).

Open vectors (from threat model):
- V2 (compromised agent exfiltrates own credential) — `api_key` mode
  still hands raw keys to agent containers; egress is wide open.
- V8 (docker.sock RW = Specifyr-RCE-to-host-root) — unchanged.
- V9 (cross-tenant leak via missing WHERE) — RLS only on
  `llm_credentials`, not yet on the rest.

## Priority order for upcoming sessions

The order maximises threat-vector closure per session and respects
external dependencies. KMS (Session D) requires a provider decision
before work starts — pick Vault Transit for self-hosted, AWS/GCP KMS
for cloud-native deployments. Sessions A–C can proceed in parallel with
that decision.

### Session A — `api_key` over the proxy (closes V2 half)
**Effort:** 1 session.
**Repos touched:** `haex-claude-proxy`, `specifyr`.

The `oauth_claude` mode is already proxy-mediated. Mirror that for
`api_key` so raw provider keys never reach agent containers.

**Proxy side:**
- Extend `createCredentialsStore.load` to also handle `mode = 'api_key'`.
  Return `{provider, apiKey, baseUrl}` instead of an OAuth plaintext.
- New code path in `handleMessages` / `handleChatCompletions`: when the
  resolved row is `api_key`, **do not** spawn `claude` CLI. Forward the
  request directly to the resolved upstream (`api.anthropic.com`,
  OpenAI, etc.) with `x-api-key: <decrypted>` and stream the response.
- Decide: keep one process for both modes, or split? Recommend one
  process — `resolveRequestHome` returns a discriminated context.

**Specifyr side (`server/projects/api/projects/[slug]/company/start.post.ts`,
`server/shared/utils/speckit-agent-runner.ts`):**
- In the `api_key` branch of `buildEnvForProfile`, mint a runner session
  exactly like the `oauth_claude` branch does already. Inject
  `ANTHROPIC_API_KEY=<sessionToken>` + `ANTHROPIC_BASE_URL=<proxy>`
  into the container.
- Drop the raw-key injection paths.
- `speckit-agent-runner.ts:envForApiKey` likewise — funnel everything
  through the proxy.

**DoD:**
- [ ] `docker inspect <agent>` for a running api_key company never shows
      the raw upstream key in env.
- [ ] An integration test starts a company with an Anthropic api_key
      credential and verifies the agent succeeds while only a session
      token is in its env.
- [ ] Proxy unit tests cover both `oauth_claude` and `api_key` paths.

**Notes / gotchas:**
- OpenAI / Google / OpenRouter all need to be proxied too, or the
  feature is half-done. Decide whether to ship Anthropic-only first
  and queue the others.
- Streaming response handling differs per upstream — verify before
  declaring DoD.

---

### Session B — Egress allowlist per company (closes V2 fully)
**Effort:** 1–2 sessions.
**Repo touched:** `specifyr`.

Today the per-company bridge from #48 isolates agents from *each other*
but they still have unrestricted outbound internet — a compromised
agent can exfiltrate anything it has access to (including its own
session token if it ever resolves it back to a real key, but more
importantly source code, secrets, etc.).

**Approach:**
- Spawn one Squid (or `tinyproxy`) sidecar per company onto the
  `co-<slug>` network. Configure it with an allowlist:
  - `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`
  - The `claude-proxy` (already attached as peer)
  - Common package mirrors: `registry.npmjs.org`, `pypi.org`,
    `*.cdn.cachix.org` (nix), `github.com`
- Per-agent: inject `HTTP_PROXY` / `HTTPS_PROXY` env. Mark the
  per-company bridge as `internal: true` (blocks default-gateway egress)
  so the proxy is the only way out.

**Touch points:**
- `src/runners/company-network.js`: add `internal: true` flag option,
  spawn sidecar container in `ensureCompanyNetwork`, return its
  container id for teardown.
- `src/runners/capability-to-docker.js`: inject `HTTP_PROXY` /
  `HTTPS_PROXY` env when agent has `network:*` capability.
- New file: `docker/squid/squid.conf.template` with the allowlist.
- `docs/SAAS_ROADMAP.md`: bump §2 to "done" when verified.

**DoD:**
- [ ] An agent without explicit-allow can `curl https://api.anthropic.com`
      but `curl https://example.com` times out / 403s through proxy.
- [ ] Removing the proxy sidecar (manual `docker rm`) leaves the agent
      with no internet at all (verifies `internal: true`).
- [ ] Sidecar logs every blocked attempt — useful audit trail.

---

### Session C — Drop docker.sock RW from specifyr (closes V8)
**Effort:** 1–3 sessions depending on option.
**Repo touched:** `specifyr` + host setup.

**Option A — rootless docker (recommended for v1):**
Host runs `rootlesskit` + rootless docker. Specifyr's `docker.sock` is
the user's rootless one, not the system root one. RCE in Specifyr
escalates to the unprivileged user, not host root.
- Mostly ops/host change; code only needs to know the socket path.
- Add ops doc in `docs/deploy/rootless-docker.md`.
- Compose changes: socket path becomes `${XDG_RUNTIME_DIR}/docker.sock`
  on the user side.

**Option B — sidecar daemon (recommended for SaaS GA):**
Small Go/Rust binary that exposes only the operations Specifyr needs
(`runAgent`, `stopAgent`, `ensureNetwork`, `removeNetwork`). Daemon is
the only thing with docker.sock; Specifyr talks over Unix socket.
Larger up-front cost, biggest attack-surface reduction.

**Decision needed:** A first, then revisit B when budget allows.

**DoD:**
- [ ] Specifyr process's effective uid:gid cannot start a `--privileged`
      / `--pid=host` container.
- [ ] Documented host setup in `docs/deploy/`.

---

### Session D — Per-org KEK via KMS (closes V5, reduces §4 blast radius)
**Effort:** 2–3 sessions (provider decision is the long pole).
**Repos touched:** `specifyr`.

Today one master AES key (`SPECIFYR_SECRET_KEY`) unwraps every tenant's
credentials. A single DB+env dump exposes every org's secrets. KMS
addresses this by giving each org its own Key-Encryption Key (KEK),
stored and audited outside the host.

**Provider decision (pick one — gates everything else):**
- **HashiCorp Vault Transit** — self-hosted, free, no external SLA dependency.
  Best for privacy-first / air-gapped operators.
- **AWS KMS** — managed, per-key audit log, IAM integration. Best if
  the prod host is already in AWS.
- **GCP Cloud KMS** — same value prop as AWS KMS for GCP hosts.

Recommendation: Vault Transit for the first deployment (avoids cloud
vendor lock-in, runs as a sidecar alongside the existing compose stack).
Re-evaluate when the first enterprise prospect demands a hosted-cloud KMS.

**Schema changes:**
- `orgs` table: add `kek_handle TEXT` column (Vault key path / AWS key ARN).
- New Drizzle migration: add column, backfill existing org(s) with a
  generated handle, provision their KEK in Vault / KMS.

**Crypto changes — envelope encryption:**
- `server/shared/crypto/llm-credentials-store.ts`: replace direct
  `encrypt(plaintext, masterKey)` with two-layer scheme:
  1. Generate a random 32-byte DEK per credential row.
  2. Encrypt plaintext with DEK (AES-256-GCM, same as today).
  3. Wrap DEK via KMS using the org's KEK handle.
  4. Store `{wrappedDek, iv, tag, data}` in `llm_credentials.oauth_credentials_data`.
- `server/shared/crypto/secrets-store.ts`: same treatment for
  `project_secrets.value_encrypted`.
- `server/shared/crypto/kms-client.ts` (new): thin adapter over
  `@hashicorp/vault-client` (or `@aws-sdk/client-kms`). Expose:
  - `wrap(orgId, dek: Buffer): Promise<string>` — returns base64 wrapped DEK.
  - `unwrap(orgId, wrappedDek: string): Promise<Buffer>`.
- `server/plugins/kms.ts` (new): initialise KMS client on Nitro startup,
  expose as `event.context.kms` (same pattern as the DB plugin).

**Migration strategy (zero-downtime):**
- Deploy behind a feature flag `KMS_ENABLED=false`. Old code path reads
  `SPECIFYR_SECRET_KEY` as before.
- When `KMS_ENABLED=true`: on each credential read, detect legacy format
  (no `wrappedDek` field), re-encrypt in-place under the org's KEK, write
  back. After all rows are migrated, remove the master-key fallback.
- One-time admin script: `pnpm run migrate:kms` — iterates all rows,
  re-encrypts under org KEK, logs progress.
- Drop `SPECIFYR_SECRET_KEY` from compose and `.env.example` only after
  migration is confirmed complete in prod.

**DoD:**
- [ ] `SPECIFYR_SECRET_KEY` is no longer present in the Specifyr container
      env after migration is complete.
- [ ] A leaked DB dump cannot be decrypted without also compromising the
      KMS service (verified by test: decrypt with wrong/absent KMS returns
      error, not plaintext).
- [ ] Each org's credentials are wrapped under a distinct KEK handle —
      org A's KMS key cannot unwrap org B's DEK.
- [ ] KMS audit log (Vault audit device / CloudTrail) shows one entry per
      credential read.
- [ ] Migration script re-encrypts all legacy rows and idempotently skips
      already-migrated rows.
- [ ] `docker inspect <specifyr>` shows no `SPECIFYR_SECRET_KEY` in env
      post-migration.

**Notes / gotchas:**
- The `haex-claude-proxy` also holds `SPECIFYR_SECRET_KEY` for decrypting
  OAuth blobs. After migration, the proxy must call the KMS client too —
  extend `haex-claude-proxy/src/crypto.js` or expose a
  `/internal/decrypt` endpoint from Specifyr that the proxy calls (simpler
  but creates coupling).
- Vault Transit in dev: add a `vault` service to `docker-compose.yml` in
  dev mode; prod runs a separate Vault cluster. Use Vault's `transit/`
  backend with one key per org, path `specifyr/orgs/<orgId>`.
- Key rotation: Vault Transit supports `rewrap` — existing ciphertexts can
  be re-wrapped under a new key version without decrypting. Schedule
  rotation policy (90 days) as part of SOC 2 controls.

---

### Session E — Extend RLS + add audit log (closes V9, advances §5)
**Effort:** 1 session.
**Repo touched:** `specifyr`.

RLS on `llm_credentials` works. Extend the same mechanic to
`projects`, `companies`, `runner_sessions`, `secrets`. Add an
append-only `audit_log` table.

**Touch points:**
- `server/shared/database/schema.ts`: declare RLS policies for the
  four other tables (mirror the existing `proxy_owner_isolation_*`
  pattern but scoped to a new specifyr-app role).
- New role `specifyr_app` (separate from `postgres`) — Specifyr Nuxt
  process connects as this role going forward. Postgres-init script
  + migration GRANTs.
- Every request middleware: `SET LOCAL app.current_user_id = $1, app.current_org_id = $2` based on the resolved auth context.
- New `audit_log` table: `{ts, actor_user_id, actor_org_id, action,
  target_table, target_id, meta jsonb}`. Append-only — revoke
  UPDATE/DELETE.
- Write hooks (Drizzle middleware or explicit calls) for: credential
  read, company start/stop, project delete, org-membership changes.

**DoD:**
- [ ] Removing a `.where(eq(t.orgId, ...))` clause in a Drizzle query
      no longer leaks cross-tenant data (RLS catches it).
- [ ] Every credential read and company start writes one `audit_log`
      row.

---

### Sessions F+ — Product & compliance (gates SaaS launch, not security)

Tracked in `SAAS_ROADMAP.md` §7 and §8. Not engineering-only — needs
business decisions on:

- Billing model (per-seat / per-token / hybrid)
- Plan tiers
- Self-signup vs. invite-only at launch
- Sub-processor list & DPA template
- Pen-test vendor

Defer until the engineering items above are done.

---

## How to use this plan in the next session

1. Read this file + `SAAS_ROADMAP.md` + `THREAT_MODEL.md` first.
2. Pick Session A as the starting point unless something has changed.
3. Each session ends with a small status update appended here under
   a `## Session log` heading (date, what landed, what's still open).
4. When an item is fully done, also flip the row in
   `SAAS_ROADMAP.md`'s status table.

## Session log

### 2026-05-13 — First follow-up session

**Landed (specifyr #46–49, #51–53 + haex-claude-proxy #3):**
- Threat model + SaaS roadmap committed (#47)
- Default resource quotas (`--cpus/--memory/--pids-limit/--ulimit nofile`) + per-company
  `co-<slug>` bridge replacing shared `companies` network (#48)
- DB-backed OAuth credentials in proxy: encrypted blobs in `llm_credentials`, decrypted
  in-process, staged into ephemeral tmpfs HOME, refreshed tokens written back (#49,
  haex-claude-proxy#3)
- Postgres RLS on `llm_credentials` actually enforced: proxy authenticates as
  `haex_claude_proxy` role, `SET LOCAL app.current_owner_*` gates SELECT/UPDATE
- `/v1/models` endpoint in proxy (Claude Code 2.1+ probe)
- KMS promoted from "deferred" to full Session D (Vault Transit recommended, envelope
  encryption, zero-downtime migration strategy) (#53)

**Still open (pick next):**
- Session A: `api_key` mode over proxy (raw keys still injected into agent containers)
- Session B: egress allowlist per company (Squid sidecar, `internal: true` bridge)
- Session C: drop docker.sock RW (rootless docker Option A)
- Session D: per-org KEK via KMS (provider decision: Vault Transit)
- Session E: extend RLS to remaining tables + audit log

### 2026-05-13 — Session A: Anthropic api_key over proxy

**Landed (specifyr feat/api-key-over-proxy + haex-claude-proxy feat/api-key-forwarding):**
- Schema bump: `runner_sessions.credential_id` (`ON DELETE SET NULL`, migration `0003_clever_namorita.sql`)
- `mintRunnerSession({ credentialId })` + `lookupRunnerSession` returns it; legacy rows
  surface `credentialId: null` and the proxy falls back to the old "latest enabled
  oauth_claude/anthropic for this owner" lookup
- `RuntimeCredential` carries `id` + `ownerKind/Id` on both variants so the runner can
  bind the session to the exact credential row
- `start.post.ts` (company) + `speckit-agent-runner.ts`: Anthropic api_key joins
  oauth_claude on the proxy path — agent env only ever sees a session token and the
  proxy URL, never the raw `sk-ant-...` key
- Proxy `createCredentialsStore.load(ownerKind, ownerId, credentialId?)` returns a
  discriminated union (`mode: 'oauth_claude' | 'api_key'`); RLS still gates the SELECT
- New `forwardAnthropicMessages(req, res, body, ctx)` in `server.js`: when the resolved
  credential is api_key, the request is HTTPS-forwarded to `api.anthropic.com` (or the
  per-credential `baseUrl` override) with `x-api-key: <decrypted>` instead of spawning
  the `claude` CLI. Streaming and non-streaming paths both pipe upstream → client
  verbatim
- Tests: 4 new in `test/auth.test.js` (api_key load path, credentialId branch, disabled
  guard, UUID validation), 2 new in `tests/db/runner-sessions-store.test.ts` (credentialId
  round-trip + ON DELETE SET NULL behavior)

**Scope decision — Anthropic only this round:**
- OpenAI / OpenRouter / Google api_key still inject raw keys. The proxy doesn't yet
  forward `/v1/chat/completions` (today's handler spawns claude for OAuth) or any
  Google endpoint shape. Queued for a follow-up; tracker row §1 in
  [SAAS_ROADMAP.md](../SAAS_ROADMAP.md) reflects the partial close.

**Still open (pick next):**
- Session A follow-up: OpenAI/OpenRouter/Google `api_key` over proxy
- Session B: egress allowlist per company (Squid sidecar, `internal: true` bridge)
- Session C: drop docker.sock RW (rootless docker Option A)
- Session D: per-org KEK via KMS (provider decision: Vault Transit)
- Session E: extend RLS to remaining tables + audit log
