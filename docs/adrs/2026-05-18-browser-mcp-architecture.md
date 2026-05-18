# ADR: Browser-side Spec Agent + Narrow REST Tool Surface

> **Status:** Accepted — 2026-05-18.
> **Owners:** maintainers.
> **Supersedes:** the container-isolation approach drafted in
> [`docs/plans/2026-05-18-untrusted-multi-tenant-isolation.md`](../plans/2026-05-18-untrusted-multi-tenant-isolation.md).
> **Implements:** [`docs/plans/2026-05-18-browser-mcp-spec-agent.md`](../plans/2026-05-18-browser-mcp-spec-agent.md).
> **Related:** [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md).

## Context

Speckit-Chat ran the agent (`claude-agent-acp`) as a server-side child
process inside the Specifyr container. Three cumulative risks made that
position untenable for the multi-tenant SaaS deployment mode described
in the threat model:

1. **Cross-tenant leak.** The agent has read access to a bind-mounted
   `/data/projects` directory that contains every org's projects. A
   prompt-injection-driven `bash` invocation can `ls` and `cat` any
   tenant's files.
2. **Server compromise via agent.** The agent process has
   `/var/run/docker.sock`, network reachability to Postgres and the
   environment with all platform credentials. An LLM-output-driven RCE
   in the agent is effectively root on the host.
3. **Per-user race.** Two members of the same org editing the same
   project's specs through the agent write into the same bind-mount;
   one user's draft work silently overwrites another's.

We evaluated two structural responses:

- **Per-org container isolation** (the superseded plan). Solves (1) and
  partially (2) but not (3) without per-user worktrees. Introduces
  Docker-in-Docker orchestration, per-org image management,
  cross-container Postgres routing, and a non-trivial operational
  burden for self-hosters.
- **Browser-side agent execution + narrow REST tool surface** (this
  ADR). Moves LLM calls and tool execution to the user's browser. The
  server stops being a code-execution surface for LLM output entirely.

A stakeholder walkthrough on 2026-05-18 selected the browser-side
approach and resolved the design questions captured below.

## Decision

The Speckit-Chat agent runs in the user's browser using the Vercel AI
SDK. The Specifyr server exposes only a small, typed, Zod-validated
REST tool surface — read-only file/spec access plus draft CRUD plus a
publish endpoint with optimistic concurrency. There is **no server-side
LLM call, no `Bash` tool, no `docker.sock` exposure** for the
Speckit-Chat path.

Concretely:

- **Where the LLM runs.** In the browser. The browser holds the user's
  provider API key (Anthropic / OpenAI / Google / OpenRouter) in
  IndexedDB and calls the provider directly via the Vercel AI SDK.
  Specifyr's server never sees the key and never proxies provider
  traffic for this path.
- **Tool surface (LLM-callable).** Seven tools, all enumerated and
  Zod-validated: `list_files`, `read_file`, `search_code`,
  `read_existing_spec`, `list_my_drafts`, `load_draft`,
  `update_draft_files`. Six map to REST endpoints (read-only against
  server state); `update_draft_files` is local IndexedDB only.
- **Tool surface (user-action, not LLM-callable).** Three: Save to
  Server (snapshot draft to DB), Publish (compare-and-swap against
  public version), Discard. Triggered from the chat UI, never from the
  model.
- **State model.** One canonical "public" spec state per project (files
  on disk + a monotonic `spec_public_version` integer). N private
  drafts per user, each tagged with the `base_version` they were
  forked from. Publish is a transactional fast-forward: succeeds iff
  `draft.base_version == project.spec_public_version`; otherwise 409
  Conflict with the new public state attached for manual reconciliation
  in the UI.
- **Privacy.** `status="draft"` rows are visible only to their
  `owner_user_id` (RLS-enforced). `status="published"` rows are
  visible to anyone with project access — they are the audit trail.
- **Provider identity.** Multi-identity per user, one active. Stored
  plain in IndexedDB (no passphrase). Cross-device sync explicitly
  out of scope: keys must be entered per device, and the server
  must never see them.
- **CSP.** Strict
  `default-src 'self'; connect-src 'self' <approved-provider-hosts>`
  on the Speckit pages, so an injected script cannot exfiltrate the
  IndexedDB-resident key to a third party.

## Consequences

### Positive

- **Threat (1) eliminated.** The server has no LLM-driven file-system
  access; tool calls hit typed endpoints scoped to one project under
  the user's existing `project-access` middleware.
- **Threat (2) eliminated for Speckit.** No server-side code-execution
  surface fed by LLM output exists for this path. (Hermes-runtime
  autonomous agents are out of scope and will be addressed on
  separate hardware in a future plan.)
- **Threat (3) eliminated.** Drafts are per-user IndexedDB state on the
  client. The single shared write — `publish` — is a CAS against
  `spec_public_version`, so concurrent publishes never silently
  clobber each other.
- **No Docker-in-Docker.** The agent no longer needs `docker.sock`.
  `claude-agent-acp` exits the Specifyr image entirely in Phase 4.
- **Per-user API quota and billing.** Provider charges land directly
  on the user's account; Specifyr stops being a fan-out for LLM cost.

### Negative

- **Browser is now the trust boundary for provider keys.** XSS on a
  Speckit page = key exfiltration. We mitigate with strict CSP, Zod
  on every server-rendered input, and no user-controlled HTML in the
  Speckit chat surface. This shifts the relevant attacker model from
  "compromised server" to "compromised browser tab," which is what
  end-user device security (OS, browser updates) is designed for.
- **No cross-device key sync.** A user who switches laptops must
  re-enter their provider key. Deliberate: the alternative requires
  the server to hold the key, which defeats the point.
- **No silent server-side replay of an in-progress session.** If a
  user's browser tab dies mid-turn, the chat resumes from the last
  IndexedDB-persisted state, not from a hot in-memory server session.
  We accept this; in practice Vercel AI SDK persists per chunk and
  recovery is near-instant.
- **Larger client bundle.** Vercel AI SDK + provider packages add
  roughly 80–120 kB gzipped to the Speckit page. Acceptable; the
  Speckit page is already gated behind authentication and rarely a
  cold-start bottleneck.
- **Future MCP integration is browser-side, not server-side.** When we
  want third-party MCP servers ("the user installs a Jira tool"),
  the plumbing lives in the browser bundle, not in a server-side
  registry. That is a future plan.

### Neutral

- **Hermes runtime is out of scope.** Autonomous, long-running runtime
  agents (the original motivation for the per-org-container plan) are
  fundamentally a server-side problem and will be deployed on
  separate hardware in a future plan. This ADR only covers
  Speckit-Chat.
- **Existing `oauth_credentials` / `llmCredentials` infrastructure**
  is not removed by this ADR. It still backs any remaining
  server-side LLM consumer (e.g. the company-Claude-proxy path that
  pre-dated the agent). Phase 4 of the implementation plan
  greps-and-decides what to retire.

## Resolved Phase-0 Design Questions

The walkthrough left three implementation-level questions open. They
are settled here so Phase 1 can start without re-litigation.

### 1. Discard semantics for `DELETE /spec-drafts/{id}`

**Decision:** Hard-delete for `status="draft"`. `status="published"`
cannot be deleted; the endpoint returns 409 Conflict if attempted.

**Rationale:**

- A draft is the user's own private work product. Soft-tombstones
  carry a trash UI, retention policy and recovery flow that nobody
  asked for.
- Published drafts are the audit trail. Their immutability is
  load-bearing for "who last published version N of this spec."
- The IndexedDB-side draft store mirrors the same rule: discard is
  hard-delete locally. Symmetric server-side semantics keep the
  mental model simple.
- If a user accidentally discards and regrets it, the IndexedDB
  copy on their device is still there until they explicitly clear
  it; this is sufficient recovery for a non-collaborative artifact.

### 2. Same-user multi-tab concurrency on one draft

**Decision:** Last-write-wins, with a UI indicator. Multi-tab editing
of the same draft is not blocked but is signalled.

**Implementation sketch:**

- Each draft view opens a `BroadcastChannel("speckit-draft:" + draftId)`
  and posts a heartbeat with a per-tab UUID. If another tab is
  detected, the UI shows a banner: *"This draft is open in another
  tab. Edits in either tab may overwrite each other — close the other
  tab to be safe."*
- IndexedDB writes are atomic per-record, so the model is
  last-writer-wins on `files` and `conversation` (not finer-grained
  field-level merging).

**Rationale:** Multi-tab is a footgun, not a feature, in this context.
Detecting and warning is cheap; the IndexedDB record-level atomicity
gives us all the concurrency primitive a single-user setup needs.

### 3. System prompt for the Speckit browser agent

**Decision:** Ship a v1 system prompt in
[`app/lib/speckit-system-prompt.ts`](../../app/lib/speckit-system-prompt.ts)
as a constant. Iterate on it during Phase 2 once we have real user
sessions.

**v1 shape (full text in the linked file):**

- Identifies the model as a *spec author*, not a coder; explicitly
  forbids writing executable code or commands.
- Enumerates the seven tools with one-line semantics each and tells
  the model when to use them ("call `read_existing_spec` once at the
  start of a session unless the user says otherwise; do not call it
  every turn").
- Encourages a section-by-section iteration loop: read what exists,
  propose one section, get user feedback, persist via
  `update_draft_files`, move on.
- Warns: tool failures are normal — surface them to the user, do not
  retry blindly.
- Defines the canonical file names (`spec.md`, `planning.md`,
  optionally `decisions.md`); the model may introduce more if asked.

**Why a string, not a templated config:** Phase 0 establishes the
shape, not the production tuning. Storing as a TypeScript constant
keeps the diff visible in PR review when we tune.

## Alternatives Considered

### Per-org container isolation (the superseded plan)

- Fixes (1) and partially (2) at the cost of significant operational
  complexity (per-org images, Docker-in-Docker, cross-container
  Postgres).
- Does not fix (3) without per-user worktrees on top.
- Keeps the server as an LLM code-execution path; CVEs in
  `claude-agent-acp` (or any successor) remain platform-criticality.
- Rejected: same security improvement is available with strictly less
  infrastructure by pushing execution to the browser.

### Server-side execution with a hardened sandbox (gVisor, nsjail)

- Closes the kernel-level surface but still leaves the agent process
  with provider credentials, project bind-mounts and Postgres
  reachability. The bind-mount problem (Threat 1) is unchanged.
- Rejected: doesn't address the structural issue, only the symptom.

### Hosted "we run the LLM, user pays via OAuth" path

- We continue to call providers from our server but with the user's
  OAuth-issued provider token. Server still holds tokens at rest.
- Loses the simplicity win (still a server-side execution path,
  still credentials on disk).
- Rejected for Speckit; may still apply to Hermes runtime later.

## Implementation

See [`docs/plans/2026-05-18-browser-mcp-spec-agent.md`](../plans/2026-05-18-browser-mcp-spec-agent.md)
for the 5-phase rollout plan. The Zod tool-surface sketch produced as
part of Phase 0 is in
[`server/shared/utils/spec-tools-schemas.ts`](../../server/shared/utils/spec-tools-schemas.ts).

## Threat-Model Updates

`docs/THREAT_MODEL.md` will be amended in Phase 1 to reflect:

- Removal of `claude-agent-acp` from the in-scope server-side
  attack surface (Phase 4 removes the binary).
- Provider API keys move from the server-side
  `llmCredentials` table to client-side IndexedDB for the Speckit
  path. The `llmCredentials` table itself remains for any
  surviving server-side LLM consumer.
- A new client-side trust boundary entry: the browser tab is now
  custodian of the user's provider key for the Speckit path; XSS on
  that page is the primary exfiltration risk and is mitigated by
  strict CSP.
