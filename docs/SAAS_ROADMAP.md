# SaaS Roadmap

> Status: living document — first cut, 2026-05-13.
> Companion to [THREAT_MODEL.md](./THREAT_MODEL.md). Order is by
> impact-per-effort, not strict dependency. Each section ends with a
> Definition of Done that maps to threat-model vectors.

The goal of this roadmap is to evolve Specifyr from a self-hosted
single-operator tool into a multi-tenant SaaS that can host unrelated
organisations on one instance. The threat model expansion that this
implies is captured in [THREAT_MODEL.md §1.2](./THREAT_MODEL.md).

## 1. Proxy-for-all credential modes

**Vectors addressed:** V2 (agent self-exfiltration), partially V3
(raw keys never in `docker inspect`).

Today only `oauth_claude` routes through `haex-claude-proxy`. The
`api_key` path injects the raw provider key into the agent container.

Target: any credential mode mints a short-lived session token. The
agent only sees `ANTHROPIC_BASE_URL=<proxy>` +
`ANTHROPIC_API_KEY=<sessionToken>`. The proxy looks up the token,
loads the raw upstream credential server-side, forwards the request.

### Scope

- `haex-claude-proxy`: extend the token resolver to also hold
  `provider`, `apiKey`, `baseUrl` (for `api_key` mode) — not just an
  OAuth credentials dir. Forward `/v1/messages` to the resolved
  upstream with the resolved key as `x-api-key` header.
- Specifyr `start.post.ts` and `speckit-agent-runner.ts`: in
  `api_key` mode, mint a runner session and inject the proxy URL +
  session token instead of the raw key. Keep the OpenAI / Google /
  OpenRouter shape only after the proxy has matching forwarders.
- DB: `runnerSessions` schema may need a discriminator (oauth dir vs.
  api_key cred id) — keep the encrypted material in `llmCredentials`,
  the session row just points at it.

### Definition of Done

- [ ] Agent containers never see raw provider keys in any mode.
- [ ] `docker inspect <agent>` for a running company shows only a
      `runnerSession` token in env vars, no upstream credential.
- [ ] Token revocation propagates within ≤30s (current TTL behaviour
      preserved).
- [ ] Proxy unit tests cover both forwarding paths.
- [ ] Integration test: company-e2e runs with `api_key` Anthropic
      credential and never exposes the key to the agent container.

## 2. Resource quotas, per-company network, egress allowlist

**Vectors addressed:** V6 (lateral movement), V7 (noisy neighbour),
partially V2 (limited exfiltration paths).

Today all agents join a single shared `companies` bridge and have no
resource limits. SaaS-blocker.

### Scope

- `capability-to-docker.js`:
  - Add `--memory`, `--cpus`, `--pids-limit`, `--ulimit nofile=…`
    defaults; allow per-agent override only within an admin-set cap.
  - Reduce `--tmpfs /tmp` size cap.
  - Replace shared `companies` network with a per-company bridge
    (`co-<companyId>`); create on company start, remove on stop.
  - Default `--network=none` for capabilities that don't need
    outbound HTTP. For agents that do: route via a per-company
    Squid/Nginx sidecar with an allowlist
    (`api.anthropic.com`, the configured proxy, package mirrors).
- `hermes-docker.js`: wire the new flags through.
- New table `companyNetworks` or transient bookkeeping for cleanup.

### Definition of Done

- [ ] Two simultaneously running companies on the same host cannot
      reach each other on IP.
- [ ] An agent without `network:internet` capability cannot reach any
      host outside the proxy + provider allowlist (verified by
      `curl` from inside the container in an integration test).
- [ ] A pathological agent (`yes > /dev/null`, fork-bomb,
      `dd if=/dev/zero of=/tmp/x bs=1M`) cannot starve other agents
      on the host.
- [ ] `docker network ls` is clean after company stop (no leaks).

## 3. Drop docker.sock RW mount

**Vectors addressed:** V8 (Specifyr-RCE → host root).

The Specifyr Nuxt process mounts `/var/run/docker.sock` RW today.
Any RCE in the Node process (XSS via tool output rendering,
prototype pollution, malicious npm dep, …) becomes host-root via
`docker run --privileged --pid=host …`.

### Options

- **A. Rootless docker** — convert the host to rootless mode. Cheap
  in compute, requires host-side ops change. Compatible with current
  code.
- **B. Sidecar daemon** — write a minimal Go/Rust daemon next to
  Specifyr that exposes only `runAgent(image, caps)` and
  `stopAgent(id)`. Specifyr talks to it over Unix socket. The daemon
  is the only thing with docker.sock. Higher up-front cost, biggest
  attack-surface reduction.
- **C. Sysbox/gVisor** — wrap agent containers in a runtime that
  doesn't trust the host kernel. Orthogonal to A/B and worth doing
  on top.

Recommend A as v1 (minimal code change), revisit B once SaaS billing
exists.

### Definition of Done

- [ ] Specifyr container has no path to launch a `--privileged` or
      `--pid=host` container even if its Node process is RCE'd.
- [ ] Documented host setup for rootless docker (or sidecar) in
      `docs/deploy/`.
- [ ] Production compose file updated.

## 4. Per-org KEK via KMS

**Vectors addressed:** V5 (DB+host leak blast radius), partially V3.

Today: one master AES key in Specifyr container env unwraps every
tenant's credentials.

### Scope

- Pick a KMS: HashiCorp Vault Transit (self-hosted), AWS KMS, or
  GCP KMS. Decision blocker — depends on the chosen hosting provider
  for the SaaS launch.
- Schema: `orgs.kekId` (string handle into the KMS).
- `llm-credentials-store.ts`: replace direct AES-GCM with
  envelope-encryption: per-credential DEK generated locally,
  wrapped with the org's KEK via KMS. Decrypt-on-use; never persist
  unwrapped DEKs.
- `secrets-store.ts`: same treatment for project secrets.
- Migration: re-encrypt existing rows under the new scheme during
  rollout; gate behind a flag until done.

### Definition of Done

- [ ] No global master key in Specifyr container env (only KMS
      credentials with `wrap`/`unwrap` permissions).
- [ ] A leaked DB dump on its own is not decryptable.
- [ ] An attacker who pops the Specifyr Node process can unwrap
      credentials only for orgs whose users are currently active
      (rate-limited by KMS audit).

## 5. Audit log + Postgres Row-Level Security

**Vectors addressed:** V9 (missing WHERE clause cross-tenant leak),
plus SaaS compliance baseline.

### Scope

- New `auditLog` table: `{ts, actor, orgId, action, target, meta}`.
  Append-only; never updated, never user-deleted (separate retention
  policy).
- Write hooks for: credential read, company start/stop, project
  delete, settings change, login.
- Postgres RLS: enable on `llmCredentials`, `secrets`, `projects`,
  `companies`, `runnerSessions`. Policies key off
  `current_setting('app.org_id')`, which Specifyr sets at the
  beginning of every request via `SET LOCAL`.

### Definition of Done

- [ ] Removing an `.where(eq(t.orgId, …))` clause in code does not
      result in cross-tenant data leakage (RLS catches it).
- [ ] Every credential read and every company start writes to
      `auditLog`.
- [ ] Audit retention documented.

## 6. Build-time image isolation

**Vectors addressed:** V10 (poisoned build layers).

`buildAgentImage` runs `nix-build`-style image construction per
agent. Today the build cache is host-wide.

### Scope

- Namespace the build cache per org (and ideally per project).
- Verify package signatures where the package manager supports it.
- Run the build itself inside a sandboxed container, not on the
  Specifyr host.

### Definition of Done

- [ ] Tenant A cannot influence what tenant B's image contains by
      pre-poisoning a cached layer.
- [ ] Build failures from one tenant cannot deny-service builds for
      other tenants (separate concurrency budget).

## 7. Product layer: signup, billing, quotas, suspension

**Vectors addressed:** none directly — gates SaaS go-live.

### Scope

- Authentik: self-signup flow, email verification, MFA optional.
- Org lifecycle: create, invite, owner-transfer, suspend
  (e.g. for non-payment), delete (GDPR cascade).
- Billing integration: Stripe or similar. Per-seat or per-token
  metering — decide based on cost model.
- Quota enforcement: companies-running-concurrently, tokens-per-day,
  storage-per-org. Enforced both at the runner layer (V7) and at
  the provider-call layer (counter incremented in the proxy).
- Status page + outage runbook.

### Definition of Done

- [ ] A new organisation can self-onboard without operator
      intervention.
- [ ] A suspended org cannot start new companies or call the
      provider.
- [ ] An org can request a full data export and a full data
      deletion.

## 8. Compliance & operator readiness

Driven by enterprise sales, not security per se.

- Threat model published (this doc + THREAT_MODEL.md).
- SOC 2 controls scaffold (logical access, change management,
  incident response).
- DPA, ToS, privacy policy — legal.
- Sub-processor list (Anthropic, Authentik provider, KMS provider,
  hosting provider).
- Penetration test before GA.
- Bug bounty channel.

## Status table

Keep this updated as PRs land.

| § | Item | Status | Tracking |
|---|---|---|---|
| 1 | Proxy-for-all credential modes | partial — `oauth_claude` mode is now fully proxy-mediated with DB-backed credentials + ephemeral tmpfs (no plaintext on disk past spawn). `api_key` mode still injects raw keys; that's the remaining work. | haexhub/haex-claude-proxy#3, specifyr#49 |
| 2 | Per-company network + quotas + egress allowlist | partial — default `--cpus/--memory/--pids-limit/--ulimit nofile` quotas live, per-company `co-<slug>` bridge replaces the shared `companies` network. Egress allowlist (Squid/Nginx sidecar per company) still open. | specifyr#48 |
| 3 | Drop docker.sock RW (rootless or sidecar) | not started | — |
| 4 | Per-org KEK via KMS | blocked on KMS decision | — |
| 5 | Audit log + Postgres RLS | partial — RLS policies on `llm_credentials` are defined in `schema.ts` and now actually enforced at runtime: the proxy authenticates as the dedicated `haex_claude_proxy` role and the `SET LOCAL app.current_owner_*` mechanic gates SELECT/UPDATE. Remaining: extend RLS to `projects`, `companies`, `runner_sessions`, `secrets`; add `auditLog` table + write hooks. | haexhub/haex-claude-proxy#3, specifyr#49 |
| 6 | Build-time image isolation | not started | — |
| 7 | Signup / billing / quotas / suspension | not started | — |
| 8 | Compliance & operator readiness | not started — written threat model exists ([THREAT_MODEL.md](./THREAT_MODEL.md)) | specifyr#47 |
