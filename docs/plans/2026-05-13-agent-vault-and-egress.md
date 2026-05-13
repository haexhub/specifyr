# Agent Vault, Identity & Egress

> Status: design plan — created 2026-05-13.
> Source of truth for the next architectural wave after
> [SAAS_ROADMAP.md §1–§2](../SAAS_ROADMAP.md) and the per-company
> bridge work landed in #48. Read
> [THREAT_MODEL.md](../THREAT_MODEL.md) first — this plan operates
> against V2, V3, V6 and reduces A2/A3 blast radius. A4 (malicious
> org owner) stays an accepted single-org risk (see "Does not close").

This plan defines how agents authenticate themselves to a secret
store, how secrets reach them, how their network egress is controlled,
and how tenants are isolated. It replaces ad-hoc `secrets.json` files
and the open-egress model with a single, spec-driven mechanism.

## Goals

1. Agents cannot read secrets they haven't been granted by spec.
2. The agent process never holds long-lived credentials. Only a
   per-container ephemeral keypair and short-lived JWTs.
3. Every secret read and every outbound request is auditable.
4. Per-spec network policy (open / allowlist / locked), enforced.
5. Tenant compromise stays within one tenant.
6. One mechanism, not N service-specific proxies.

## Non-Goals

- Per-organisation **physical** stack (own vault/dns/postgres
  container per org). One shared vault, one shared DNS, one shared
  Postgres. Isolation is logical: Postgres schema + per-org DB role
  (see "Isolation" section). If an enterprise customer ever requires
  physical separation we plan that separately.
- Hardware-backed identity (TPM, SPIFFE/SPIRE). Software Ed25519
  keypair in tmpfs is enough until proven otherwise.
- Per-process trust boundary **inside** the agent container. Keypair
  lives in agent-process memory; one container = one identity.
- Service-specific knowledge in the egress proxy. The proxy speaks
  HTTP CONNECT and matches Host against the spec's allowlist —
  nothing more. Service-specific behaviour (gh CLI auth, jira tokens
  etc.) lives in the agent image via Nix packages + wrapper scripts.

## Big picture

```text
┌─ Host ─────────────────────────────────────────────────────────────┐
│                                                                    │
│  ┌─ specifyr-vault ──────────────────────┐  ┌─ specifyr-dns ────┐  │
│  │  - Ed25519 challenge/response         │  │  Blocky:          │  │
│  │  - JWT mint (vault-wide signing key)  │  │  - DoH upstream   │  │
│  │  - Secret API (encrypted reads)       │  │  - global block-  │  │
│  │  - HTTP CONNECT egress proxy          │  │    lists (malware │  │
│  │  - Audit log writer                   │  │    + ads + DoH    │  │
│  │  tcp: gateway:8888                    │  │    endpoints)     │  │
│  │   ├─ CONNECT  → egress proxy          │  │  udp/tcp 53       │  │
│  │   └─ GET/POST → /auth/*, /secrets/*   │  │                   │  │
│  └───────────┬───────────────────────────┘  └─────────┬─────────┘  │
│              │                                        │            │
│              ▼                                        │            │
│  ┌─ postgres ────────────────────────────┐            │            │
│  │  schema org_<id>                      │            │            │
│  │   ├── service_credentials             │            │            │
│  │   ├── agent_specs                     │            │            │
│  │   ├── agent_sessions (with pubkey)    │            │            │
│  │   ├── secret_access_log               │            │            │
│  │   └── jwt_signing_keys                │            │            │
│  │  + per-org DB role                    │            │            │
│  └───────────────────────────────────────┘            │            │
│                                                       │            │
│  ┌─ Agent-Container (per agent run) ────────────────────────────┐  │
│  │  network: co-<org>-<spec> bridge, fixed container_ip         │  │
│  │  dns: specifyr-dns                                           │  │
│  │  env: HTTPS_PROXY=http://gateway:8888                        │  │
│  │  env: SPECIFYR_VAULT_URL=http://gateway:8888                 │  │
│  │  mount: /run/specifyr/identity.key (tmpfs, 0400, deleted)    │  │
│  │  nftables: drop OUTPUT except → vault tcp 8888 + dns 53      │  │
│  │  CAP_NET_ADMIN dropped after init                            │  │
│  │                                                              │  │
│  │  vault-client (in agent process or sidecar lib):             │  │
│  │    privkey → challenge → JWT → secret-fetch / proxy-CONNECT  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

Three new components on the host (`specifyr-vault`, `specifyr-dns`,
new Postgres schemas). One new spec dialect (`agent-spec.yaml`).
Agent containers gain a tmpfs identity, a fixed bridge IP that vault
binds the session to, a DNS override and nftables rules.

## Components

### specifyr-vault

Custom Go service running on the host. **Not** HashiCorp Vault or any
of its forks — the name overlap is unfortunate but the scope is much
smaller: one binary, one TCP listener (`gateway:8888`) that speaks
HTTP CONNECT (egress proxy) and plain HTTP (REST API for auth and
secrets). Go is chosen for static single-binary distribution, small
attack surface, and good crypto stdlib. Open source, lives alongside
specifyr in the same monorepo or a sibling repo.

Replaces both the current file-based `secrets-store.ts` and the
existing `runner_sessions` proxy concept for non-LLM credentials.
**The existing haex-claude-proxy stays separate** for LLM traffic
(it's a stable chokepoint) — this vault is for all *other* service
credentials and for egress policy.

Responsibilities:

1. **Identity verification** — Ed25519 challenge/response per session.
   Every auth and secret request additionally checks that the
   request's source IP equals the session's recorded `container_ip`.
2. **JWT issuance** — short-lived (15min), signed with the
   vault-wide JWT signing key, carries `org_id`, `session_id`,
   `spec_hash`, granted permissions. The `org_id` claim drives
   schema/role selection downstream; the signing key is not itself
   per-org (the org boundary is enforced by Postgres schema + role
   + RLS, not by JWT crypto). A forged JWT for org B used through
   the vault role for org A still cannot read org B's data because
   the connection is bound to org A's role.
3. **Secret read API** — given JWT + secret name, return decrypted
   value; enforce per-spec allowlist.
4. **HTTP CONNECT proxy** — same listener, CONNECT verb only.
   Validates JWT, matches Host against per-spec egress allowlist,
   forwards or denies.
5. **Audit** — every challenge, JWT mint, secret read and CONNECT
   target written to `secret_access_log` with org/session/spec
   correlation.

Interface:

All endpoints share one TCP listener at `gateway:8888`. Source IP must
match `agent_sessions.container_ip` or the request is dropped before
auth is even evaluated.

| Path | Verb | Auth | Purpose |
|---|---|---|---|
| `/auth/challenge` | POST | session_id + src-IP match | returns one-time nonce, 30s TTL |
| `/auth/token` | POST | session_id + src-IP match + Ed25519 signature over nonce | returns JWT |
| `/secrets/:name` | GET | JWT + src-IP match | returns decrypted value |
| (any host) | CONNECT | JWT (Proxy-Authorization) + src-IP match | egress proxy |

Operations:
- Stateless **per request** (sessions/nonces in Postgres or Redis).
  Multiple instances behind LB possible.
- Health endpoint, Prometheus metrics.
- Postgres role: `specifyr_vault` — read-only on
  `service_credentials`, read+write on `agent_sessions` and
  `secret_access_log` for the org schemas it serves.

### specifyr-dns

Containerised Blocky instance, single host-wide service.

Config sketch:

```yaml
upstreams:
  groups:
    default:
      - https://dns.quad9.net/dns-query
ports:
  dns: 53
  http: 4000   # Prometheus
blocking:
  denylists:
    malware:
      - https://hagezi.github.io/dns-blocklists/multi/tif.txt
    ads:
      - https://hagezi.github.io/dns-blocklists/multi/pro.txt
    doh-bypass:
      - https://hagezi.github.io/dns-blocklists/multi/doh.txt
  clientGroupsBlock:
    default: [malware, ads, doh-bypass]
queryLog:
  type: postgresql        # for audit correlation
```

The DoH-bypass list is non-negotiable — without it the agent can
DNS-over-HTTPS to Cloudflare/Google and skip our resolver entirely.

DNS does **not** see secrets and is identical across orgs. Shared
instance is fine.

### Agent container init

A small init binary (Go preferred — single static binary, no
runtime). Runs as PID 1 with `CAP_NET_ADMIN`, sets up the
environment, drops capabilities, execs the agent.

Steps (order matters — `setuid` resets several prctl flags, so the
hardening calls come *after* the uid switch):

1. Read `/run/specifyr/identity.key` (Ed25519 private key, mode 0400,
   tmpfs-mounted by Specifyr at container start). Buffer in memory.
2. Read `/run/specifyr/session.json` (session_id, vault URL, spec
   hash, resolved internal CIDRs — informational, the real
   enforcement is in vault).
3. Apply nftables rules (needs `CAP_NET_ADMIN`):
   - `DROP` everything on `OUTPUT`.
   - `ACCEPT` to `specifyr-vault` (tcp 8888 on the vault peer IP).
     All vault traffic (auth, secrets, CONNECT proxy) shares this
     listener.
   - `ACCEPT` to `specifyr-dns` (udp/tcp 53).
   - `ACCEPT` loopback.
   - `ACCEPT` to each resolved internal CIDR from `session.json`.
4. `unlink()` and zero-overwrite the identity.key file in tmpfs.
5. `setuid` to a non-root agent UID. This implicitly drops every
   capability from the Permitted+Effective sets (kernel default
   without `PR_SET_KEEPCAPS`, which we deliberately do not set —
   nftables work is done).
6. `prctl(PR_SET_NO_NEW_PRIVS, 1)` — blocks any future setuid /
   file-capability gain.
7. `prctl(PR_SET_DUMPABLE, 0)` — block ptrace / core dumps. **Must
   be after step 5**: `setuid` resets `dumpable` to the system
   default (1), so setting it before would silently revert.
8. `exec` the actual agent process, passing identity via env or fd
   (not on disk).

If any step fails, the init binary `_exit(1)`s immediately — never
fall through to step 8 with partial hardening.

## Identity & auth flow

### Boot-time keypair generation

The vault-daemon does **not** trust the agent container to generate
its own keypair — bootstrap-without-trust-anchor is too brittle.
Instead, Specifyr (the Nuxt server) does this when it spawns an
agent:

1. Generate Ed25519 keypair.
2. Insert row into `agent_sessions`:
   `{ session_id, org_id, spec_id, public_key, status: 'pending', expires_at: NOW() + 1h }`.
3. Write privkey to a per-container host tmpfs path with mode 0400,
   owner = the container's mapped UID.
4. Pass that path as a docker bind-mount.
5. The init binary inside the container reads it and `unlink`s
   immediately. After that, the host-side tmpfs file is gone too
   (anonymous inode, last fd closed).

Privkey never lives on persistent disk and never travels over
network. Specifyr-server holds it for milliseconds.

### Challenge / response

```text
agent-process                            specifyr-vault
     │                                         │
     │ POST /auth/challenge                    │
     │    { session_id }                       │
     ├────────────────────────────────────────►│
     │                                         │ src_ip == row.container_ip
     │                                         │ row.status must = 'pending'
     │                                         │ or jwt_count < N
     │                                         │
     │                  ◄──────────────────────┤
     │  { nonce, expires_in: 30 }              │
     │                                         │
     │ sig = Ed25519_sign(privkey, nonce       │
     │                              ‖ session  │
     │                              ‖ ts)      │
     │                                         │
     │ POST /auth/token                        │
     │    { session_id, ts, signature }        │
     ├────────────────────────────────────────►│
     │                                         │ src_ip == row.container_ip
     │                                         │ verify sig with row.public_key
     │                                         │ ts within 10s of now
     │                                         │ nonce not yet redeemed
     │                                         │ load permissions from spec
     │                                         │ row.status := 'active'
     │                                         │ sign JWT with vault signing key
     │                                         │  (org claim drives RLS scope)
     │                                         │
     │                  ◄──────────────────────┤
     │  { jwt, exp: +15min, jti }              │
```

JWT claims:

```json
{
  "iss": "specifyr-vault",
  "sub": "session-xyz",
  "org": "org-abc",
  "spec": "sha256:...",
  "perm": {
    "secrets": ["jira-prod", "github-pat"],
    "egress": {
      "mode": "allowlist",
      "hosts": ["api.github.com", "*.atlassian.net"]
    }
  },
  "iat": 1715591400,
  "exp": 1715592300,
  "jti": "..."
}
```

Permissions are embedded so the proxy and secret API can decide
locally without a DB roundtrip per request. The vault still writes
the audit row.

### Refresh

No separate refresh token. When the JWT is within ~1min of expiry,
the agent re-runs challenge → token with the same privkey. The
privkey *is* the refresh credential. Container restart =
new keypair = new session.

## Spec schema

```yaml
# agent-spec.yaml
name: jira-triager
version: 1

# Image composition (build-time)
tools:
  nix:
    - nixpkgs#gh
    - nixpkgs#atlassian-cli
  mcp:
    - "@modelcontextprotocol/server-postgres"

# Secrets (runtime, gated by vault)
secrets:
  - name: jira-prod
    mount: vault            # on-demand fetch via vault HTTP, default
  - name: github-pat
    mount: env:GITHUB_TOKEN  # for tools that can't do better
  - name: workspace-db-readonly
    mount: vault

# Egress (required — no default)
egress:
  mode: allowlist           # 'open' | 'allowlist' | 'locked'
  allow:
    - api.github.com
    - "*.atlassian.net"
    - registry.npmjs.org

# Internal networks (Docker network names the agent may join)
internal:
  - workspace-db
```

Validation: Zod schema, mirrored on server. `egress.mode` is
**required**, no default — explicit is safer than implicit. Spec
hash is content-addressed (sha256 of the canonical JSON form) and
referenced from `agent_sessions.spec_hash`.

Spec changes require user approval (re-confirm UI), exactly like
adding a new OAuth scope.

### Resolving `internal:` to subnets

The spec lists *names*; the init binary needs *CIDRs* for its
nftables ACCEPT rules. Specifyr does the resolution at boot time:

1. **Ownership check**: every Docker network name an org may
   reference must be either created by Specifyr for that org (label
   `com.specifyr.org=<org_id>`) or explicitly whitelisted by an
   operator. Specifyr filters out anything else at spec-approval
   time, so unknown names can never get past validation. This is
   what prevents cross-tenant lateral movement via a shared internal
   net — an org cannot reference another org's network by name.
2. **CIDR lookup**: `docker network inspect <name>` → read
   `IPAM.Config[].Subnet`. Cache for the run; networks don't
   reshape mid-run.
3. **Multi-network attach**: after the `co-<slug>` connect (boot
   step 4), Specifyr also runs `docker network connect <name>
   <container>` for each entry. The container now has one extra
   interface per internal net.
4. **Inject into session.json**: Specifyr writes the resolved CIDR
   list into `/run/specifyr/session.json` before `docker start`.
   The init binary reads it and adds one `ACCEPT … oifname … to
   <cidr>` per entry to the nftables ruleset.

V1 carries the consequence that whoever joins an internal net joins
the whole net — there is no per-port allowlist inside an internal
subnet. If finer scoping is needed, operators must split the network
(e.g. `org_<id>_pg` vs `org_<id>_redis`) and let the spec opt in
explicitly.

## Secret mount modes

Two modes, both ultimately backed by the same vault API:

| Mode | Mechanism | Visibility |
|---|---|---|
| `env:VAR` | Init fetches secret once, sets `VAR` in process env before exec | Visible in `/proc/<pid>/environ`, inherited by children. Convenience escape hatch for tools that can't fetch on demand. |
| `vault` | Tool calls `GET http://gateway:8888/secrets/<name>` each time needed | Lives only in the requesting process. Default. |

For `vault` mode, the agent image ships small wrappers for common
tools:

```sh
# /usr/local/bin/jira (replaces real jira CLI)
#!/bin/sh
export JIRA_TOKEN=$(vault-fetch jira-prod)
exec /opt/atlassian-cli/jira "$@"
unset JIRA_TOKEN
```

`vault-fetch` is a tiny client that signs requests with the in-memory
privkey + JWT. Users can write their own wrappers in the agent spec.

## Egress modes

| Mode | nftables | vault-proxy behaviour |
|---|---|---|
| `open` | accept → vault + dns + loopback only | CONNECT to any host, logged |
| `allowlist` | same | CONNECT only to spec-listed hosts, else 403 |
| `locked` | accept → vault + dns + loopback + listed internal nets | CONNECT denies all external, internal-only via direct connect |

In all modes:
- DNS blocklist (`specifyr-dns`) applies globally.
- Audit logs include every CONNECT target and status.
- Direct outbound to Internet (bypassing the proxy) is impossible
  because nftables drops it.

`locked` is intended for agents that operate purely on the workspace
(refactor, migration, local-test). They can still reach their own
workspace's Postgres on a docker-internal network.

### Host matching (CONNECT proxy)

The proxy decides allow/deny on the **CONNECT request-target only**
(`CONNECT api.github.com:443 HTTP/1.1`). It does not, and cannot,
inspect TLS — once allowed, bytes are tunneled verbatim. Concretely:

- **Wildcards match exactly one label**, the same convention as TLS
  certificates. `*.atlassian.net` matches `foo.atlassian.net` but
  not `atlassian.net` itself and not `a.b.atlassian.net`. To allow
  both apex and one-level subdomains, list both: `atlassian.net`
  and `*.atlassian.net`.
- **No partial label wildcards** (`foo*.example.com` is rejected at
  spec-validation time).
- **Bare IP CONNECT targets** (`CONNECT 1.2.3.4:443`) are denied in
  V1. Reaching specific IPs is a job for the spec's `internal:` list
  (which lives at the network layer, not the proxy).
- **Port restriction**: V1 allows only `:443` and `:80` through the
  proxy. Other ports are denied even if the host is on the allowlist.
- **Match is case-insensitive** on the host, byte-exact on the port.

What the audit log captures for a CONNECT:

| Field | Source | Notes |
|---|---|---|
| `target` | CONNECT request-target | `<host>:<port>` as the client sent it |
| `granted` | match result | true if 200, false if 403 |
| `session_id`, `spec_hash`, `org_id` | JWT | from `Proxy-Authorization` |

After a 200 the tunnel is opaque — no path, no headers, no body, no
bytes-transferred-out (we could add a counter later for cost
accounting, but it's not security-relevant: a compromised agent can
still exfiltrate up to the per-host quota of bytes once a host is
allowed; the defence is the allowlist, not the byte counter).

## Isolation

Two layers, both always on. Physical separation (own vault/dns/pg
container per org) is explicitly out of scope — see Non-Goals.

### Layer 1 — logical (in-process checks)

- Every spec, session, secret and audit row carries `org_id`.
  vault rejects any request whose JWT `org_id` claim doesn't match
  the resource's `org_id`.
- One vault-wide JWT signing key (kid embedded in JWT header for
  future rotation support; not rotated on a schedule, only on
  suspected compromise).
- RLS on `secret_access_log` so operator views are org-scoped.

### Layer 2 — Postgres schema + role

- Each org gets its own Postgres schema: `org_<id>`.
- Each org gets its own Postgres role: `org_<id>_app` with `USAGE`
  on its schema and **no** access to other schemas.
- vault connects with the org's role when serving requests for that
  org (per-request connection from a pool keyed by `org_id`).
- Even SQL injection inside vault would be bounded to the active
  org's schema — the connection literally cannot see other schemas.

### Envelope encryption (per-org master keys)

The encryption hierarchy:

```text
KEK  (Key Encryption Key)        — outside Postgres, ONE per instance
  │
  │  encrypts
  ▼
DEK  (Data Encryption Key)       — in Postgres, ONE per org
                                   stored encrypted-with-KEK in
                                   org_<id>.master_keys row
  │
  │  encrypts
  ▼
service_credentials.encrypted_value, etc.
```

Properties:
- Each org has its own DEK. Decrypting org A's secrets gives no help
  for org B's secrets.
- DEKs are stored encrypted in Postgres. Postgres alone is not
  enough to read any secret — you also need the KEK.
- The KEK lives outside Postgres, fetched by vault on startup,
  decrypted-in-memory only. Source is pluggable:
  - **OpenBao** (Apache 2.0 fork of HashiCorp Vault) for self-hosted
    deployments that want a real KMS. Vault calls
    `transit/decrypt` to unwrap each DEK on demand.
  - **Cloud KMS** (AWS KMS, GCP KMS) for cloud deployments.
  - **Env var fallback** for dev / small self-host — KEK is a 32-byte
    value in `SPECIFYR_KEK`. Documented as "not for multi-tenant
    SaaS production" in the runbook.
- Vault never sees a plaintext DEK on disk. DEK lives in vault
  process memory, cleared on shutdown.

**KEK lifecycle.** The KEK is provisioned **once at server install
time** and is the absolute root of trust. Two install modes:

- **Self-hosted / dev**: operator generates a random 32-byte value
  and sets `SPECIFYR_KEK` in the environment before first start.
  Lost KEK = lost data. Runbook prescribes secret-share backup
  (e.g. `ssss`) on day one.
- **Managed KMS**: operator points vault at an existing
  OpenBao/AWS-KMS/GCP-KMS key. Vault doesn't see the KEK material
  itself — it asks the KMS to unwrap each DEK on demand.

The KEK is never copied between environments; staging and prod each
have their own. Specifyr **does not** generate the KEK at first
boot — that would put the key into whatever wrote `compose up`, with
no audit trail.

**DEK lifecycle.** Each DEK is generated automatically by vault on
org-create (see Bootstrap sequences) and lives for the lifetime of
the org. **DEK rotation is not automated in V1.** The schema
supports rotation (active flag + `service_credentials.dek_id`), and
an admin-triggered "rotate DEK" endpoint can be added later, but
the security gain for V1 is marginal:

- compliance-driven rotation is V2/SaaS-GA work
- if a DEK leaks, the KEK has usually leaked too (same host) — DEK
  rotation alone wouldn't help
- AES-GCM's 2^32 invocation limit is practically unreachable

KEK rotation is also out of scope for v1 — designed for it (every
`master_keys` row has a `kek_kid` reference), but no automated job.

## Data model (Drizzle sketch)

The existing global `orgs` table gains two columns:

```ts
// orgs — existing table, two new columns
export const orgs = pgTable('orgs', {
  // ... existing columns ...
  // /24 from SPECIFYR_BRIDGE_POOL, allocated at org-create, fixed
  // for the lifetime of the org. Used by docker network create
  // --subnet=... and by Specifyr's IPAM for picking container_ip.
  bridgeSubnet: cidr('bridge_subnet').notNull(),
  // Org-create is a saga (DDL commit, then vault call). 'ready' is
  // the only state in which agents may spawn; any other state means
  // the vault init hasn't finished yet (or failed and needs retry).
  initStatus: text('init_status', {
    enum: ['pending_vault_init', 'ready'],
  }).notNull().default('pending_vault_init'),
});
```

New tables, all in per-org schemas:

```ts
// service_credentials — replaces filesystem secrets.json
export const serviceCredentials = pgTable('service_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),          // logical name e.g. 'jira-prod'
  ownerId: uuid('owner_id').notNull(),
  // FK to the DEK that encrypted this row. Required for rotation:
  // a row encrypted under DEK_v1 must still be decryptable after
  // DEK_v2 is introduced, by looking up the original DEK via dekId.
  dekId: uuid('dek_id').notNull().references(() => masterKeys.id),
  // AES-256-GCM ciphertext + iv + tag, key is the unwrapped DEK
  // referenced by dekId.
  encryptedValue: text('encrypted_value').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  rotationReminderAt: timestamp('rotation_reminder_at'),
  createdAt: timestamp('created_at').defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
}, t => ({
  uniqOwnerName: uniqueIndex().on(t.ownerId, t.name),
}));

// agent_specs — versioned, content-addressed
export const agentSpecs = pgTable('agent_specs', {
  hash: text('hash').primaryKey(),       // sha256 of canonical JSON
  ownerId: uuid('owner_id').notNull(),
  name: text('name').notNull(),
  version: integer('version').notNull(),
  body: jsonb('body').notNull(),          // validated YAML→JSON
  approvedAt: timestamp('approved_at'),   // null until user approves
  approvedBy: uuid('approved_by'),
});

// agent_spec_secrets — which credentials a spec is allowed to read
export const agentSpecSecrets = pgTable('agent_spec_secrets', {
  specHash: text('spec_hash').notNull().references(() => agentSpecs.hash),
  credentialId: uuid('credential_id').notNull().references(() => serviceCredentials.id),
  mountMode: text('mount_mode', { enum: ['vault', 'env'] }).notNull(),
  envVarName: text('env_var_name'),       // null if mountMode = vault
}, t => ({
  pk: primaryKey({ columns: [t.specHash, t.credentialId] }),
}));

// agent_sessions — one row per running container
export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  specHash: text('spec_hash').notNull().references(() => agentSpecs.hash),
  containerId: text('container_id'),
  // IP pre-assigned by Specifyr from the org's bridge subnet, before
  // the container is created (so the row already has the right value
  // by the time vault sees the first /auth call). Vault rejects any
  // /auth or /secrets request whose source IP doesn't match.
  containerIp: inet('container_ip').notNull(),
  publicKey: text('public_key').notNull(),   // Ed25519, hex
  status: text('status', { enum: ['pending', 'active', 'expired', 'revoked'] }).notNull(),
  jwtIssuedCount: integer('jwt_issued_count').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
}, t => ({
  // Concurrent agent spawns must never reserve the same container_ip.
  // Partial unique index: only live reservations are unique; expired
  // and revoked rows can share an IP (the IP is then free for reuse).
  // Implemented as `CREATE UNIQUE INDEX ... WHERE status IN
  // ('pending','active')` in the migration.
  oneLiveIpReservation: uniqueIndex()
    .on(t.containerIp)
    .where(sql`${t.status} IN ('pending', 'active')`),
}));

// master_keys — per-org DEK(s), encrypted with vault-wide KEK.
// Lives in each org's own schema. Vault-only access.
//
// Semantics:
// - V1 invariant: exactly ONE row has active=true at any time. This
//   is the DEK that encrypts every newly-written service_credentials
//   row. Vault enforces this at write time and refuses to start if
//   it sees multiple actives on boot.
// - Older inactive rows are kept so existing credentials remain
//   decryptable until they are re-encrypted under the new active
//   DEK. service_credentials.dek_id picks the right row at read
//   time, regardless of active.
// - Rotation flow (manual in V1, automated later): INSERT new row
//   with active=true (transactional UPDATE-old-to-active=false in
//   the same TX) → background job re-encrypts each credential
//   under the new DEK and updates dek_id → optionally delete the
//   old row once dek_id-count drops to zero.
export const masterKeys = pgTable('master_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Reference to which KEK was used to wrap this DEK. Allows
  // future KEK rotation without re-wrapping all DEKs at once.
  kekKid: text('kek_kid').notNull(),
  // The DEK itself, AES-256, encrypted with the referenced KEK.
  // Stored as base64 ciphertext + iv + tag.
  wrappedDek: text('wrapped_dek').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  active: boolean('active').notNull().default(true),
}, t => ({
  // Partial unique index enforces the "at most one active" invariant
  // at the DB level (Postgres: CREATE UNIQUE INDEX ... WHERE active).
  oneActive: uniqueIndex().on(t.active).where(sql`${t.active} = true`),
}));

// auth_nonces — one-shot, short-lived. Vault deletes rows where
// expires_at < now() - 1d opportunistically on every challenge write,
// so the table stays bounded without a separate cron.
export const authNonces = pgTable('auth_nonces', {
  nonce: text('nonce').primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => agentSessions.id),
  expiresAt: timestamp('expires_at').notNull(),
  redeemedAt: timestamp('redeemed_at'),
});

// secret_access_log — append-only audit
export const secretAccessLog = pgTable('secret_access_log', {
  id: bigserial('id').primaryKey(),
  sessionId: uuid('session_id').notNull(),
  specHash: text('spec_hash').notNull(),
  event: text('event', {
    enum: ['challenge', 'token_mint', 'secret_read', 'egress_connect', 'egress_denied']
  }).notNull(),
  target: text('target'),                    // secret name or hostname
  granted: boolean('granted').notNull(),
  ip: inet('ip'),
  occurredAt: timestamp('occurred_at').defaultNow(),
});
```

All of the above live under `org_<id>` schema (Layer 2). Migrations
generate the schema dynamically when an org is created.
`secret_access_log` is append-only — no UPDATE/DELETE grants for the
vault role.

In addition, **one vault-wide schema** `specifyr_vault` holds the
single JWT signing key:

```ts
// vault-wide, ONE active row at a time. Kid lets us swap on suspected
// compromise without coordinated downtime (old JWTs accepted until
// expiry, new JWTs signed with new kid).
export const jwtSigningKey = pgTable('jwt_signing_key', {
  kid: text('kid').primaryKey(),
  publicKey: text('public_key').notNull(),
  // Ed25519 privkey, wrapped with the KEK directly (no per-org DEK
  // here — this key is not org-scoped).
  wrappedPrivateKey: text('wrapped_private_key').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  kekKid: text('kek_kid').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  active: boolean('active').notNull().default(true),
}, t => ({
  // Same "at most one active" invariant as masterKeys — enforced at
  // DB level so concurrent inserts can't create two active signing
  // keys (which would break JWT verification semantics).
  oneActive: uniqueIndex().on(t.active).where(sql`${t.active} = true`),
}));
```

## Bootstrap sequences

Three distinct lifecycles need explicit ordering: first-ever start of
the whole stack, every cold-start of vault, and creation of a new org.
Specifyr owns DDL; vault owns crypto. The two coordinate over a small
internal HTTP API on vault that Specifyr can reach (peer-on-bridge,
shared-secret auth).

### First-ever stack start

1. Postgres comes up.
2. Specifyr (via Drizzle migrations) creates the **vault-wide**
   `specifyr_vault` schema with `jwt_signing_key`. No rows yet.
3. Specifyr ensures the `specifyr_vault` Postgres role exists with
   `SELECT/UPDATE` on `specifyr_vault.jwt_signing_key` and per-org
   schemas (granted at org-create, see below).
4. Vault container comes up. It:
   - loads KEK from its configured provider (env / OpenBao / KMS) —
     fails fast if the KEK is missing or rejected;
   - connects to Postgres as `specifyr_vault`;
   - reads the active row from `jwt_signing_key`. If empty:
     generates an Ed25519 keypair, wraps the private key with the
     active KEK, INSERTs the row (`active=true`, generated `kid`).
     Subsequent starts skip generation and just unwrap.
   - holds the unwrapped private key in process memory only.
5. Vault opens its TCP listener on `:8888` and registers on each
   `co-<slug>` bridge as a peer (the company-network code adds it
   alongside Specifyr + claude-proxy).

If step 4 finds **multiple** rows with `active=true`, vault refuses
to start — that state is only produced by a manual error and must be
resolved manually (it would otherwise create JWT-verification
ambiguity).

### Vault cold-restart

Same as step 4–5 above, minus the keypair generation. The KEK
provider must be reachable on every restart; vault is a hard
dependency for any agent run.

### Org create

Owned by Specifyr (the existing org-onboarding code path), with one
asynchronous call out to vault for the crypto step. Cross-service
"transactional rollback" is not real — an HTTP call to vault cannot
be undone by a Postgres rollback, and vault can't see Specifyr's
DDL until it commits anyway. So org-create runs as a two-step
saga with a `pending` status on the org row.

1. **Allocate a bridge subnet** for the new org from the global pool
   (`SPECIFYR_BRIDGE_POOL`, e.g. `10.20.0.0/14`). Specifyr picks the
   next free `/24` by scanning `orgs.bridge_subnet` of existing orgs.
   The pool is sized for the deployment's expected org count (a /14
   gives 1024 /24 subnets ≈ 1024 orgs).
2. **DDL transaction (committed before vault is called)**:
   - `INSERT INTO orgs` with `bridge_subnet` and `init_status =
     'pending_vault_init'` (new status column on `orgs`).
   - `CREATE SCHEMA org_<id>`.
   - Create the per-org tables (`service_credentials`, `agent_specs`,
     `agent_spec_secrets`, `agent_sessions`, `master_keys`,
     `auth_nonces`, `secret_access_log`).
   - `CREATE ROLE org_<id>_app` with `USAGE` on the schema, table-
     level grants per the read/write matrix (e.g. `secret_access_log`
     gets INSERT only — no UPDATE/DELETE).
   - Grant `specifyr_vault` role the access it needs across the new
     schema (read on credentials/specs/sessions, append on audit).
   - **COMMIT.** From here on, vault can see the schema.
3. **Specifyr → vault: `POST /internal/orgs/<id>/init`** (mTLS or
   shared-secret authenticated; this endpoint is not exposed to
   agent bridges, only to the Specifyr-vault peer link). The
   endpoint is **idempotent on `org_id`**: if a row in
   `org_<id>.master_keys` already exists with `active=true`, vault
   returns 200 with the existing kid rather than generating a new
   DEK (this is what makes retry safe).
4. **Vault**: generates a 32-byte DEK, wraps it with the active KEK,
   `INSERT` into `org_<id>.master_keys` with `active=true` and
   `kek_kid` pointing at the KEK used. Returns 200.
5. **Specifyr** `UPDATE orgs SET init_status = 'ready'` on success.
   Until that flip, the org cannot spawn agents (the agent-start
   path refuses to run for any org whose `init_status != 'ready'`).

**Failure handling.** If step 3 or 4 fails (network, vault down,
KEK provider down), the org row stays in `pending_vault_init`
indefinitely — no time-out, no automatic rollback. Two recovery
paths:

- **Synchronous retry from the API**: the same onboarding endpoint
  can be re-hit; it sees `init_status='pending_vault_init'` and
  re-attempts step 3. Idempotency makes this safe.
- **Background reconciler**: a periodic job (every few minutes)
  picks up orgs stuck in `pending_vault_init` for >N minutes and
  retries the vault call. Operators can also drive it manually.

We deliberately do **not** auto-roll-back the DDL on vault failure.
Dropping a schema risks losing in-progress work if anyone has
already raced to write into it; leaving an empty schema with
`init_status=pending` is cheap and recoverable.

The bridge subnet is set once and never changes for the lifetime of
the org. Network creation (`docker network create co-<slug>
--subnet=<orgs.bridge_subnet>`) happens lazily on the first agent
run, not at org-create — there's no reason to materialise an empty
bridge.

The reason DEK generation lives in vault, not in the Specifyr
migration: only vault is supposed to know about plaintext DEKs (and
only in-memory). Specifyr owning the DEK during a migration would
defeat the boundary.

The existing `capability-to-docker.js` + company start path needs the
following additions, in order:

1. **Allocate a container IP** from the org's bridge subnet
   (`orgs.bridge_subnet`, set at org-create — see Bootstrap
   sequences). Specifyr's IPAM picks the next IP that is not in use
   by any `agent_sessions` row with `status IN ('pending','active')`
   for this org and not in the reserved range for peers (vault,
   claude-proxy, specifyr-host get fixed low addresses, e.g. .2/.3/.4
   per bridge). The picked address is reserved by writing the row
   first; the actual `docker create` comes next.
2. **Create session row** in `agent_sessions` with `status: 'pending'`,
   `container_ip = <picked>`, `expires_at: NOW() + run_ttl`. The
   row's existence in 'pending' is the IPAM reservation.
3. **Generate Ed25519 keypair**. Write privkey to host tmpfs path
   `/run/specifyr/sessions/<container_id>/identity.key`, mode 0400,
   owner = container UID. Store pubkey in the session row.
4. **`docker create`** with the picked IP — keep `--network` off
   here, the explicit `--ip=` goes on the `network connect` so it
   binds atomically:
   - `--mount type=bind,src=...identity.key,dst=/run/specifyr/identity.key,readonly`
   - `--dns specifyr-dns-ip`
   - `--env HTTPS_PROXY=http://<vault-ip-on-bridge>:8888`
   - `--env HTTP_PROXY=http://<vault-ip-on-bridge>:8888`
   - `--env SPECIFYR_VAULT_URL=http://<vault-ip-on-bridge>:8888`
   - `--env NO_PROXY=localhost,127.0.0.1,<internal-cidrs>`
   - `--env SPECIFYR_SESSION_ID=<session_id>`
   - `--cap-add NET_ADMIN` (init only, dropped by init binary)
   - existing `--cap-drop ALL --security-opt no-new-privileges
     --read-only --pids-limit --memory --cpus`
5. **`docker network connect --ip=<picked> co-<slug> <container>`**
   binds the pre-allocated IP. Docker rejects if the IP is already
   in use — that case means stale state in our IPAM table and
   should be cleaned up by reconciling `agent_sessions` with
   `docker network inspect` on cold-start.
6. **`docker start`** with init binary as ENTRYPOINT. Init reaches
   vault immediately; the IP-pin check passes because the row
   already carries the right `container_ip`.
7. **After 5s** (or on first JWT mint): delete host-side
   identity.key file. If init didn't read it by then, container is
   broken anyway.
8. **On container stop**: mark session `status: 'expired'` so any
   leftover JWT becomes invalid at its TTL. The IP becomes free for
   allocation again (any new session-row write skips IPs of
   non-expired rows; expired rows release them implicitly).

Why pre-allocate `--ip=` instead of letting Docker pick:
- The session row carries the right IP **before** the container can
  speak to vault — no transient state where init beats Specifyr's
  inspect+update.
- A deterministic subnet per bridge (set in step "Org create")
  means vault can sanity-check that an incoming `RemoteAddr` is
  even *inside* the org's range — defence-in-depth on top of the
  per-session pin.
- Reverse correlation from `secret_access_log.ip` to an org is
  trivial (subnet membership), useful for any forensic work later.

**Vault must be a peer on every `co-<slug>` bridge.** Today's
`ensureCompanyNetwork` (#48) attaches Specifyr-host + claude-proxy.
Add `specifyr-vault` to that peer list with a fixed low IP (e.g.
the `.2` of the subnet, reserved). Reason: if the agent reached
vault via the bridge gateway instead of a peer-on-bridge, Docker
would SNAT all egress to the gateway IP and `RemoteAddr` would
collapse to one value for every container in the bridge — the
IP-pin would become meaningless. As a peer-on-bridge, vault sees
the genuine container IP. `<vault-ip-on-bridge>` (the env var the
agent sees in step 4) is that fixed reserved address.

## Migration path (existing → target)

The existing systems we replace:

- `secrets-store.ts` (filesystem `secrets.json`) →
  `service_credentials` table.
- The "project secrets" injected as `-e` flags in
  `company/start.post.ts` (the `buildEnvForProfile` path; current
  line numbers will drift, search for it) → vault HTTP reads (or
  `env:` mount mode for backward compat).
- Direct egress from agent containers → forced through vault proxy.

`llm_credentials` and `haex-claude-proxy` stay as they are. They're
already proxy-mediated and well-tested. Vault is for *everything
else* — non-LLM service credentials.

Migration script:
1. For each `<dataDir>/.specifyr/<slug>/secrets.json`, decrypt with
   existing master key, re-insert into `service_credentials` under
   the org-schema.
2. Generate a default `agent-spec.yaml` for each existing company
   role with `egress.mode: open` and every existing secret mounted
   as `env:` (preserves today's behaviour).
3. Surface in UI: "your specs default to open egress — review and
   tighten".
4. Keep filesystem path readable for one release as fallback, then
   delete.

## Phases & PRs

The order minimises risk: data layer first, then runtime, then
enforcement.

**Phase 1 — Data layer** (1 PR)
- Vault-wide `specifyr_vault` schema with `jwt_signing_key` table
  (one active row).
- Per-org tables under `org_<id>` schemas (Layer 1+2).
- Schema bootstrap on org create (DDL only — `CREATE SCHEMA`,
  tables, role grants). DEK generation is **not** part of the
  migration; that's vault's job over `POST /internal/orgs/<id>/init`
  (see Bootstrap sequences → Org create). The migration leaves
  `master_keys` empty for the org to be filled by vault after
  commit.
- Per-org Postgres role provisioning.
- KEK source: pluggable interface (`OpenBaoKekProvider`,
  `EnvKekProvider`); default to `EnvKekProvider` for dev.

**Phase 2 — Spec schema + UI** (1 PR)
- Zod schema for agent-spec.
- Approval UI: user reviews secret + egress claims before a spec
  becomes runnable.
- Spec hash, content-addressing.

**Phase 3 — vault-daemon (auth + secrets only)** (2 PRs)
- Service skeleton, HTTP API on `gateway:8888`.
- Challenge/response, JWT mint, secret read.
- Source-IP pin: every endpoint rejects requests whose `RemoteAddr`
  doesn't match `agent_sessions.container_ip`.
- Tests: keypair rotation, session expiry, replay protection,
  cross-org isolation, IP-pin enforcement.

**Phase 4 — Container init binary** (1 PR)
- Tmpfs identity reader.
- nftables rule application + capability drop.
- `vault-fetch` helper.

**Phase 5 — vault-daemon egress proxy** (1 PR)
- HTTP CONNECT proxy with JWT auth + per-spec allowlist match.
- Audit on every connect.
- Mode handling (open / allowlist / locked).

**Phase 6 — DNS resolver** (1 PR)
- Blocky container + compose entry.
- Block lists + DoH-bypass list.
- Wire agent containers' `--dns` flag.

**Phase 7 — Migration & cleanup** (1 PR)
- Migrate `secrets.json` to `service_credentials`.
- Default specs for legacy companies.
- Remove old filesystem secret path.

Phases 1–2 can run in parallel. Phases 3–6 are sequential. Phase 7
is the cutover.

## Open questions

- **OpenBao deployment topology.** Single shared OpenBao instance
  for the whole specifyr installation, or one OpenBao per host?
  Single instance is simpler operationally; multi-instance gives
  blast-radius reduction at the KEK level. v1: single shared
  OpenBao, document in runbook how to swap for cloud KMS.
- **Audit-log retention.** Forever in Postgres will balloon. Plan
  for partition + cold-archive to S3-compatible storage. Out of
  scope for v1, but design the table for it (already done —
  bigserial PK, append-only).
- **nftables vs. eBPF.** nftables is well-understood, works in
  containers without kernel modules. eBPF would give finer-grained
  policy and per-process attribution. Stick with nftables for v1.
- **DEK rotation triggers (post-V1).** V1 has no DEK rotation (see
  "Envelope encryption"). When that changes, the open product
  question is which events should trigger a rotate: scheduled
  cadence, member-with-secret-access-leaves, explicit admin button,
  or some combination. Schema is rotation-ready (active flag +
  `service_credentials.dek_id`); only the trigger policy is open.

## Open vectors this closes / does not close

Closes (fully):
- **V2** — agent self-exfiltration. Privkey is in-memory, JWTs are
  short, egress goes through vault with audit + allowlist.
- **V6 (egress half)** — outbound is constrained to declared hosts.

Closes (partially):
- **V3** — raw secrets in `docker inspect`. `env:` mount mode still
  shows secret values to `inspect`. `vault` mode doesn't. We'll
  recommend `vault`.

Does not close:
- **A2 cross-tenant** — Layer 1+2 (org-claim + schema/role) is strong
  but not physical. A2 with vault-daemon RCE could still read all
  orgs the daemon serves. Physical separation (own vault per org)
  closes it; see Non-Goals — deferred to a later wave.
- **A3 exfil via allowed services** — agent with GitHub permission
  can still open an issue at attacker's repo containing the token.
  Mitigation is scoping the credential (fine-grained PATs) and
  human review of agent output.
- **A4 malicious org owner** — accepted. An org owner can see all
  their org's secrets and approve specs that exfiltrate them — that
  is owner privilege, not a vulnerability. Blast radius stays inside
  that one org (per-org Postgres schema + role), so other tenants
  are unaffected. No mechanism in this plan, by design.
- **A5 operator with shell** — out of scope by design.

## Acceptance for v1

- [ ] An agent without `secrets: [foo]` in its spec cannot read `foo`
      from the vault (403 with audit row).
- [ ] An agent with `egress.mode: allowlist` cannot
      `curl https://evil.com` (DNS blocks + nftables drops + proxy
      403 — three layers).
- [ ] An agent with `egress.mode: open` can curl arbitrary hosts
      *except* those on the global DNS blocklist, with full audit.
- [ ] Stealing the agent's tmpfs identity key in flight does not
      let an attacker auth from a different container: vault rejects
      `/auth/*` and `/secrets/*` requests whose `RemoteAddr` doesn't
      match the session's recorded `container_ip`. Verified by a test
      that replays a valid signature from a sidecar container on the
      same host and asserts 403.
- [ ] JWT issued for org A cannot read secrets from org B: the JWT
      `org` claim selects the Postgres schema and role; even a
      forged JWT for org B used through the vault's per-request
      connection bound to org A's role cannot see org B's data.
- [ ] `docker inspect <agent>` shows `SPECIFYR_SESSION_ID` and proxy
      env vars, no plaintext credentials (for specs using `vault`
      mounts).
- [ ] Container restart invalidates the previous keypair within the
      JWT TTL.
- [ ] Migration script ports an existing company's
      `secrets.json` to the new model without data loss and the
      previously-working flow keeps working under a generated default
      spec.

## References

- [THREAT_MODEL.md](../THREAT_MODEL.md) — V2, V3, V6, A2, A3
- [SAAS_ROADMAP.md](../SAAS_ROADMAP.md) — §1 proxy-for-all-creds,
  §2 egress, §3 KMS
- [docs/plans/2026-05-13-saas-followup-plan.md](./2026-05-13-saas-followup-plan.md)
  — open items list
- [haex-claude-proxy](https://github.com/haexhub/haex-claude-proxy)
  — LLM-side proxy (stays unchanged)
- Blocky — https://github.com/0xERR0R/blocky
- HTTP Message Signatures — RFC 9421 (for the
  challenge/response signature format)
