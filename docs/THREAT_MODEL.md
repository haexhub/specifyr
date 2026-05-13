# Specifyr Threat Model

> Status: living document — first cut, 2026-05-13.
> Owners: maintainers. Update whenever a new trust-boundary, attacker, or
> credential-flow is introduced.

This document is the source of truth for what Specifyr is and is NOT
trying to defend against. Use it when designing features that touch
credentials, agent isolation, multi-tenancy or external integrations.
If a code change weakens a mitigation listed here, the change must
either (a) update this document or (b) be rejected.

## 1. Deployment modes

Specifyr supports two operating modes with very different threat models:

### 1.1 Self-hosted, single-operator (today)

One operator runs Specifyr on their own infrastructure. All users of
the instance trust the operator and (effectively) each other. The
operator has shell on the host. Authentik provides login, but everyone
on the instance is in the same trust domain.

Threat focus: protect against external attackers and obvious bugs.
Operator-equivalent access is out of scope.

### 1.2 Multi-tenant SaaS (target)

Multiple unrelated organisations share one Specifyr instance. Tenants
do not trust each other. The operator (Specifyr provider) is trusted
by tenants to safeguard their data and credentials, but not to read
them at will.

Threat focus: tenant isolation, custodianship of stored credentials,
auditability.

Everything below distinguishes the two modes where relevant.

## 2. Assets

| Asset | Where it lives | Sensitivity |
|---|---|---|
| User OAuth tokens (Anthropic, providers) | `llmCredentials` table, AES-256-GCM encrypted, mounted creds dir for proxy | High — direct billing / data access |
| Raw LLM API keys (`api_key` mode) | `llmCredentials` table, encrypted | High |
| Agent runner session tokens | `runnerSessions` table (short TTL) | Medium — revocable, scoped to one user |
| Master encryption key | Env var on Specifyr container | Critical — unwraps all `llmCredentials` |
| Project data (repos, specs, agent output) | Host filesystem under project root | Medium — tenant code/IP |
| User identity (email, Authentik subject) | `users` table | Medium |
| Org membership | `orgs`, `orgMembers` | Medium |

## 3. Trust boundaries

```
                    ┌─────────────────────────────────────────────────┐
                    │ Specifyr host (single trust domain)             │
                    │                                                 │
   end user ──HTTP──┼──► Specifyr Nuxt server ──spawns──► docker     │
   (browser)  ▲     │   (has DB master key)              daemon       │
              │     │                  │                  │           │
              │     │                  ▼                  ▼           │
              │     │              Postgres            agent          │
              │     │              (encrypted          containers     │
              │     │               credentials)      (per company,   │
              │     │                                  per role)      │
              │     │                  ▲                  │           │
              │     │                  │                  ▼           │
              │     │              claude-proxy ◄── ANTHROPIC_BASE_URL│
              │     │              (resolves tokens                   │
              │     │               → creds dir or                    │
              │     │               raw key forward)                  │
              │     └─────────────────────────────────────────────────┘
              │
              └── Authentik (separate trust domain, IDP)
```

The current trust boundary that matters most for SaaS:
**Specifyr host ↔ Agent container** is enforced by docker isolation
(`--cap-drop=ALL`, no `--pid=host`, no `--privileged`,
`--security-opt=no-new-privileges`, `--read-only`).

The boundary that is **not** enforced today:
**Tenant A's agent ↔ Tenant B's agent.** Both share the `companies`
bridge network, see each other's bind-mounted profile dirs only if
they share a project, run under the same host UID (Specifyr process
UID).

## 4. Attackers

| ID | Actor | In scope? | Notes |
|---|---|---|---|
| **A1** | Unauthenticated internet attacker | yes | Standard web attacker. |
| **A2** | Authenticated user in tenant X trying to read tenant Y's data | SaaS: yes / single-op: no | The whole point of SaaS isolation. |
| **A3** | Compromised LLM agent (prompt-injection, malicious tool output) | yes | The agent is given its own user's credential by design. Cannot be fully prevented — must be contained. |
| **A4** | Malicious organisation owner attacking the Specifyr instance | SaaS: yes | Treat tenant-supplied configs as untrusted input. |
| **A5** | Specifyr operator with shell on the host | out of scope | Equivalent to root. Mitigated only by operational controls (access logs, dual-control, etc.) — not by code. |
| **A6** | Supply-chain (poisoned npm/PyPI/Nix package consumed by agents or Specifyr itself) | yes (best-effort) | Pin versions, vendor-lock when possible. |

## 5. Credential flow (current state)

```
User adds API key in UI
  │
  ▼
encrypt(AES-256-GCM, masterKey) → llmCredentials row
  │
  ▼
Company start (start.post.ts):
  ├─ api_key mode    → decrypt → docker run -e ANTHROPIC_API_KEY=raw
  └─ oauth_claude    → mint runnerSession token →
                       docker run -e ANTHROPIC_API_KEY=<sessionToken>
                                   -e ANTHROPIC_BASE_URL=<proxy>
                       proxy resolves token → /credentials/<id>/
```

The `api_key` path is the legacy form; the `oauth_claude` path is the
proxy-mediated form introduced for OAuth credentials. The roadmap
extends proxy-mediation to **all** credential modes (see
[SAAS_ROADMAP.md](./SAAS_ROADMAP.md) §1).

## 6. Identified vectors

> Numbering matches the labels used in design discussions so the issue
> tracker can reference them directly.

### V1 — Agent-to-agent env read via /proc
**Status: blocked by docker isolation.** Each container has its own
PID namespace; no `--pid=host`. Container A cannot read
`/proc/$PID/environ` of container B.

### V2 — Compromised agent exfiltrates its own credential
**Status: open. Worst-case impact = single user's credential.**
The agent process needs the key to call the LLM provider; prompt
injection or malicious tool output can exfiltrate it via any allowed
network egress. Mitigations are stacked:
- Roadmap §1 (proxy-for-all): agent only sees a short-lived session
  token, never the raw key.
- Roadmap §2 (egress allowlist): restrict outbound traffic to the
  provider API + proxy + known package mirrors.

### V3 — Host-shell user reads all credentials
**Status: accepted in self-hosted; mitigated by operational controls
in SaaS.** `docker inspect` shows env vars, `ps auxe` shows argv
briefly, and the master key is in the Specifyr container's env.
Anyone with host shell or `docker` group access can decrypt the DB.
Roadmap §3 (rootless docker or sidecar daemon) and §4 (KMS-wrapped
per-org KEKs) raise the bar but do not eliminate the vector.

### V4 — Shared profile dir / `auth.json` between users
**Status: bounded.** `auth.json` is deleted at company start
(`start.post.ts`). If two users in the same org share a project, they
also share `<project>/.hermes/<role>/auth.json` during a run — but
sharing a project implies sharing trust in the SaaS model.

### V5 — Encrypted-at-rest DB leak
**Status: standard risk.** AES-256-GCM with a master key in the
Specifyr container env. A DB-only leak (e.g. backup theft without the
host) is non-fatal; a DB+host leak is fatal. Roadmap §4 (KMS / per-org
KEK) reduces blast radius.

### V6 — Shared docker bridge `companies`
**Status: SaaS-blocker.** Agents of different tenants can reach each
other on IP, enabling lateral movement if any agent process is
exploited. Roadmap §2 fixes this with per-company networks +
default-deny egress.

### V7 — Resource exhaustion / noisy neighbour
**Status: SaaS-blocker.** No `--memory`, `--cpus`, `--pids-limit`,
disk quota in `capability-to-docker.js`. One tenant can DoS the
instance. Roadmap §2.

### V8 — docker.sock RW mount → Specifyr-process RCE = host root
**Status: SaaS-blocker.** Acknowledged in `docker-compose.yml`.
Roadmap §3.

### V9 — Cross-tenant DB row leak (missing WHERE clause)
**Status: open — defended app-side only.** Today, tenant scoping
is enforced in TypeScript query helpers. A single forgotten
`.where(eq(table.orgId, …))` is a cross-tenant leak. Roadmap §5
adds Postgres Row-Level-Security as defence-in-depth.

### V10 — Build-time image poisoning
**Status: low-priority, monitored.** `buildAgentImage` builds Nix
packages per agent. If a layer cache is shared across tenants and one
tenant poisons a package, others inherit it. Roadmap §6 isolates
builds per org.

## 7. Out-of-scope (today)

- Hardening against malicious Specifyr operators (A5).
- Defending against compromised Authentik / IDP.
- Defending against rogue admins of the upstream LLM provider.
- Side-channel attacks below the docker isolation layer (Spectre-class,
  shared-CPU timing). Mitigated only by running on a non-shared host.

## 8. Change-control rule

Any PR that:
- changes how a credential travels from DB to agent process,
- relaxes any docker isolation flag,
- introduces a new bind-mount,
- adds a network reachable from agent containers,

MUST update this document (or be rejected). Bot-style enforcement is
optional but recommended once the SaaS roadmap is delivered.
