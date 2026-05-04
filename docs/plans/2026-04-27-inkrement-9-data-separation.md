# Inkrement 9 — Code / Live-Data Separation

## Context

specifyr's runtime data currently lives **inside** the code checkout:

```
/home/haex/Projekte/specifyr/      ← git repo (code)
├── projects/                       ← user sandboxes (live data)
│   ├── asas/  fwbg/  hh/  test/
└── .specifyr/                       ← per-project state (queue, events, runs)
    ├── asas/  hh/  ...
```

Symptoms:
- `git pull` collides with locally-modified user files in `projects/<slug>/`
  whenever spec-kit installs an extension or the user runs anything
- `projects/` was committed by accident (235 files, 38k lines) until
  fixed in `94b2545`/`745d923`
- A multi-host or upgrade-by-replace deploy (delete code dir, re-clone)
  would silently destroy user data
- Backup of "the code repo" pulls in unrelated user state with credentials,
  artefacts, queue history

The previous commit gitignored `projects/` as the cheap fix. **This
inkrement does the structural fix:** runtime data lives outside the code
tree, code becomes safely deletable/replaceable.

## Goal & Non-Goals

### In scope
- A single canonical `dataRoot()` function — every store anchors there,
  not at `process.cwd()`
- Configurable via `SPECIFYR_DATA_DIR` env, default
  `${XDG_DATA_HOME:-$HOME/.local/share}/specifyr/`
- Migrate **all** cwd-rooted data writes (queues, events, runs, manifests,
  task graphs, sessions, step-state, artefacts, project sandboxes)
- Dual-path support during migration: existing data in `<cwd>/projects/`
  and `<cwd>/.specifyr/` keeps working; an explicit migration helper
  moves it on demand
- Update `docker-compose.yml` to mount a named volume (or bind mount) for
  data, separate from the source bind mount
- Update `SPECIFYR_HOST_PROJECT_ROOT` translation in dockerRunnerFactory
  to reflect the new layout

### Out of scope (stay in cwd)
- `catalog/` (tool/skill catalog manifests — code-tracked, not user-data)
- `extensions/` (community catalog cache — derivable, not user-data)
- `tests/fixtures/` (test code)
- `docs/`, `src/`, `server/`, `app/`, `components/`, `pages/`
- App config (`.specifyr/config.json`-equivalents) **may** stay in cwd or
  move — see Open Question 1
- Test harness changes (most tests already use tempdirs, no migration
  needed)

## Design

### Path layout after migration

```
$SPECIFYR_DATA_DIR/                  default: ~/.local/share/specifyr/
├── projects/                         user-checked-out spec-kit projects
│   └── <slug>/                       (was: <cwd>/projects/<slug>/)
└── runtime/                          per-project orchestrator state
    └── <slug>/                       (was: <cwd>/.specifyr/<slug>/)
        ├── queue/   events/   runs/
        ├── tasks.graph.json
        ├── extensions.json
        └── ...
```

Renaming `.specifyr/` → `runtime/` is optional but cleaner — the dotted
form was a hidden-dir convention from when it was *inside* a user
project. In its own data tree, we don't need to hide it. Decide in 9.1.

### `dataRoot()` API

Lives in `src/core/data-root.js` (testable from `node --test`):

```js
export function dataRoot() {
  if (process.env.SPECIFYR_DATA_DIR) return process.env.SPECIFYR_DATA_DIR;
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share");
  return path.join(xdg, "specifyr");
}

export function projectsRoot()  { return path.join(dataRoot(), "projects"); }
export function runtimeRoot()   { return path.join(dataRoot(), "runtime"); }
export function projectDir(slug)        { return path.join(projectsRoot(), slug); }
export function projectRuntimeDir(slug) { return path.join(runtimeRoot(), slug); }
```

server-side wrapper in `server/utils/data-paths.ts` re-exports the same
helpers (Nuxt-bundle constraint, mirrors `mcp-auth.ts` pattern).

## Implementation Plan

### 9.1 — Foundations

- Create `src/core/data-root.js` with `dataRoot/projectsRoot/runtimeRoot`
- Decide: rename `.specifyr/` → `runtime/` (recommended) vs. keep
- Add unit tests for env precedence (SPECIFYR_DATA_DIR > XDG_DATA_HOME
  > $HOME/.local/share)
- Add `server/utils/data-paths.ts` thin wrapper

### 9.2 — Migrate the Nitro server side

`server/utils/specifyr-stores.ts`:
- `projectCwd(slug)` → `projectDir(slug)` (uses dataRoot)
- `hostProjectRoot()` / `projectHostCwd(slug)` — these are about the
  Docker-out-of-Docker host path; with data outside cwd, the host path
  becomes `${SPECIFYR_HOST_DATA_DIR}/projects/<slug>`. Update env name.
- `loadEventStore(slug)` — base dir becomes `projectRuntimeDir(slug)`

Endpoints to fix (search for `path.join(process.cwd(), ".specifyr"...)`):
- [server/api/projects/[slug]/run/start.post.ts](../../server/api/projects/[slug]/run/start.post.ts)
- [server/api/projects/[slug]/run/status.get.ts](../../server/api/projects/[slug]/run/status.get.ts)
- [server/api/projects/[slug]/run/tasks/[tid]/log.get.ts](../../server/api/projects/[slug]/run/tasks/[tid]/log.get.ts)
- `skip.post.ts`, `retry.post.ts`, `cancel.post.ts`
- [server/api/projects/[slug]/extensions.get.ts](../../server/api/projects/[slug]/extensions.get.ts)
- [server/api/projects/[slug]/extensions/[extSlug].delete.ts](../../server/api/projects/[slug]/extensions/[extSlug].delete.ts)
- [server/api/projects/[slug].delete.ts](../../server/api/projects/[slug].delete.ts)
- [server/api/projects/[slug]/company/start.post.ts](../../server/api/projects/[slug]/company/start.post.ts)
- [server/utils/extension-install.ts](../../server/utils/extension-install.ts)

Pattern: replace `path.join(process.cwd(), ".specifyr", slug, ...)` with
`path.join(projectRuntimeDir(slug), ...)`.

### 9.3 — Migrate the src/core stores

These already accept `cwd` as a constructor argument and default to
`process.cwd()`. The fix is at the **call sites** (above) — pass
`projectRuntimeDir(slug)` (or its parent) instead of process.cwd().

Stores reviewed:
- [src/core/run-store.js](../../src/core/run-store.js) — RunStore(cwd)
- [src/core/session-store.js](../../src/core/session-store.js) — SessionStore(cwd)
- [src/core/event-store.js](../../src/core/event-store.js) — EventStore(baseDir)
- [src/core/step-state.js](../../src/core/step-state.js) — StepStateStore(cwd)
- [src/core/artifact-store.js](../../src/core/artifact-store.js) — ArtifactStore(cwd)
- [src/core/task-graph.js](../../src/core/task-graph.js) — getOrBuildTaskGraph({cwd, slug, projectCwd})
- [src/core/app-config.js](../../src/core/app-config.js) — see Open Question 1

No core-store rewrites needed — the contract stays "you pass me a base
dir". Only the wiring changes.

### 9.4 — docker-compose.yml + host-path env

```yaml
services:
  specifyr:
    environment:
      SPECIFYR_DATA_DIR: /data                # container-side
      SPECIFYR_HOST_DATA_DIR: ${SPECIFYR_HOST_DATA_DIR:-${HOME}/.local/share/specifyr}
    volumes:
      - .:/app                                  # source (read-mostly for HMR)
      - specifyr_data:/data                    # named volume OR
      # - ${SPECIFYR_HOST_DATA_DIR}:/data       # bind mount to host XDG dir

volumes:
  specifyr_data:
```

Bind-mount variant (recommended): user can `ls ~/.local/share/specifyr/`
and inspect their data without `docker exec`. Named-volume variant is
more portable but opaque.

`SPECIFYR_HOST_PROJECT_ROOT` (introduced in inkrement 6.2) gets
replaced by `SPECIFYR_HOST_DATA_DIR` because the bind-mount source for
sibling agent-containers now anchors at the data dir, not at the code
dir. dockerRunnerFactory's `projectRoot` argument receives
`${SPECIFYR_HOST_DATA_DIR}/projects/<slug>` instead of
`${SPECIFYR_HOST_PROJECT_ROOT}/projects/<slug>`.

### 9.5 — Migration helper

One-time move for users with existing data in `<repo>/projects/` and
`<repo>/.specifyr/`. Two options:

**A) `pnpm migrate:data` script** — explicit user action. Reads source
paths, dataRoot, mv with rsync. Safe, auditable.

**B) Auto-migrate on first start** if old paths exist and dataRoot is
empty. Convenient but magical (and dangerous if run with stale state).

Recommend **A**. Script lives at `scripts/migrate-data-to-xdg.mjs`,
documented in the README. Idempotent: re-running after migration is a
no-op (source paths absent).

### 9.6 — Tests

- 4 new tests for `dataRoot()` env precedence (in `tests/data-root.test.js`)
- Update existing tests where they pass `process.cwd()` explicitly to
  store constructors — now pass tempdirs (most already do via
  `withTempProject`)
- E2E test (`company-e2e.test.js`) needs no change — it already mints
  a tempdir and passes it as projectRoot
- Smoke test: integration test that drops a queue YAML in the new
  dataRoot location and asserts pickup (parallel to existing test that
  uses tempdir)

## Open Questions

1. **Where does `.specifyr/config.json` live?** It holds `localExtensions`
   (filesystem paths to extension repos). Two reads:
   - **(a) Stay in `<cwd>/.specifyr/config.json`** — it's per-installation
     code config, not user-data. Move to `<repo>/config/app.json` or
     keep at current path.
   - **(b) Move to `${dataRoot}/config.json`** — it's user state (which
     extensions THIS user has registered).
   Lean toward (b) for consistency, but (a) is defensible. Pick early
   in 9.1.

2. **Rename `.specifyr/` to `runtime/`?** Recommended because we no
   longer need a hidden dir (it's its own tree now). But it's a doc /
   plan / commit-message search-and-replace job in addition to the move.

3. **Backwards-compat for path env vars?** Should `SPECIFYR_DATA_DIR`
   fall back to reading the OLD `SPECIFYR_HOST_PROJECT_ROOT` if the
   new one isn't set? Probably no — clean break is simpler; the
   migration helper documents the swap.

4. **Tests under tempdirs vs. the new dataRoot?** Tests should NOT touch
   `~/.local/share/specifyr/`. Easiest: the test setup forces
   `SPECIFYR_DATA_DIR=<tempdir>` for every test via a `beforeEach` or
   per-test env override. Document in the test README.

## Verification

```bash
# Unit
node --test tests/data-root.test.js

# Smoke: data lands in the right place
SPECIFYR_DATA_DIR=/tmp/haex-data-test pnpm dev   # start nuxt
curl -X POST http://localhost:3000/api/projects/foo/...
ls /tmp/haex-data-test/  # → projects/foo/  runtime/foo/

# Migration
mkdir -p projects/legacy-test/.specify
mkdir -p .specifyr/legacy-test/queue
node scripts/migrate-data-to-xdg.mjs --dry-run
node scripts/migrate-data-to-xdg.mjs
ls ~/.local/share/specifyr/projects/   # → legacy-test/
ls ~/.local/share/specifyr/runtime/    # → legacy-test/

# E2E
SPECIFYR_DATA_DIR=$(mktemp -d) RUN_E2E_TESTS=1 \
  ANTHROPIC_API_KEY=... \
  node --test tests/integration/company-e2e.test.js
```

## Critical Files Reference

Reads/writes that need rerouting (pre-migration; survey via
`grep -rn 'process\.cwd()' src/ server/ | grep -v test`):

| File | Concern |
|---|---|
| [server/utils/specifyr-stores.ts](../../server/utils/specifyr-stores.ts) | `projectCwd`, `hostProjectRoot`, `loadEventStore` — main entry points |
| [server/utils/extension-install.ts](../../server/utils/extension-install.ts) | `manifestPathFor` builds `<cwd>/.specifyr/<slug>/extensions.json` |
| [server/utils/run-manager.ts](../../server/utils/run-manager.ts) | scheduler base dir |
| [server/api/projects/[slug]/...] | every endpoint that builds `<cwd>/.specifyr/<slug>/...` paths |
| [src/core/run-store.js](../../src/core/run-store.js), [session-store.js](../../src/core/session-store.js), [event-store.js](../../src/core/event-store.js), [step-state.js](../../src/core/step-state.js), [artifact-store.js](../../src/core/artifact-store.js), [task-graph.js](../../src/core/task-graph.js) | already accept cwd-param; only wiring at call sites |
| [docker-compose.yml](../../docker-compose.yml) | new volume + env, `SPECIFYR_HOST_PROJECT_ROOT` → `SPECIFYR_HOST_DATA_DIR` |
| [src/runners/hermes-docker.js](../../src/runners/hermes-docker.js) | dockerRunnerFactory consumes the new host-side data path |

## Out of Inkrement-9 (defer further)

- Multi-tenancy: per-user data roots (today: single shared dataRoot)
- Encryption-at-rest for queue/events
- Backup tooling for the data root
- Garbage-collection of old runs / events
- Retention policies

## Pre-flight checklist

- [ ] Decide Open Question 1 (`.specifyr/config.json` location) — affects
      9.2 wiring scope
- [ ] Decide Open Question 2 (`.specifyr/` → `runtime/` rename) — affects
      grep/replace scope
- [ ] Confirm a baseline backup of `~/.local/share/` exists before running
      the migration script for the first time
- [ ] Stash or commit any pending work in `.specifyr/<slug>/run/` —
      migration moves files, in-flight runs would be interrupted

## Estimated effort

4-5 focused hours. Risk: Open Question 1 could double the wiring scope
if config also moves. Recommended sequencing: do 9.1+9.2+9.3 in one
PR-sized chunk (cwd → dataRoot for runtime data only), defer config
relocation to a follow-up if needed.
