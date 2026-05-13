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
external dependencies. KMS (§4 in the main roadmap) is *deprioritised*:
host-compromise is the dominant threat, and §3 addresses it more
fundamentally than KMS does. Revisit §4 the day before the first SOC 2
audit or first enterprise vendor questionnaire.

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

### Session D — Extend RLS + add audit log (closes V9, advances §5)
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

### Sessions E+ — Product & compliance (gates SaaS launch, not security)

Tracked in `SAAS_ROADMAP.md` §7 and §8. Not engineering-only — needs
business decisions on:

- Billing model (per-seat / per-token / hybrid)
- Plan tiers
- Self-signup vs. invite-only at launch
- Sub-processor list & DPA template
- Pen-test vendor

Defer until the engineering items above are done.

---

## When to revisit KMS (§4)

Triggers, any of:
- First enterprise prospect sends a vendor security questionnaire
  asking about key custody.
- SOC 2 audit scheduled.
- Compliance contract (HIPAA / PCI / GDPR DPIA) demands HSM-backed
  key storage.

When that day comes, the work is:
1. Pick a KMS (Vault Transit / AWS KMS / GCP KMS) — biggest decision,
   ties to hosting choice.
2. Add `orgs.kek_handle` column.
3. Refactor `llm-credentials-store.ts` + `secrets-store.ts` to
   envelope-encryption: per-row DEK locally generated, wrapped via
   KMS with the org's KEK.
4. Migration: re-encrypt existing rows under the new scheme behind
   a flag. Old rows stay decryptable via legacy master key until
   migration completes.
5. Drop the master-key env var.

## How to use this plan in the next session

1. Read this file + `SAAS_ROADMAP.md` + `THREAT_MODEL.md` first.
2. Pick Session A as the starting point unless something has changed.
3. Each session ends with a small status update appended here under
   a `## Session log` heading (date, what landed, what's still open).
4. When an item is fully done, also flip the row in
   `SAAS_ROADMAP.md`'s status table.

## Session log

_(empty — first follow-up session will append here)_
