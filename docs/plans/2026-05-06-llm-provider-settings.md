# LLM Provider Settings Page

**Status:** Draft — awaiting sign-off
**Author:** mdrechsel@itemis.com
**Date:** 2026-05-06

## Goal

Single global settings page that lets the user manage credentials for the
LLM providers specifyr can talk to:

- **Anthropic** — API-Key OR Claude Pro/Max via OAuth (through the
  existing `haex-claude-proxy` sidecar).
- **OpenAI** — API-Key.
- **Google (Gemini)** — API-Key.
- (Open: local LLM via Ollama-URL — see "Open questions".)

Today the only LLM-credential path is `ANTHROPIC_API_KEY` baked into env
vars at boot ([nuxt.config.ts:28-29](../../nuxt.config.ts#L28-L29),
[server/api/projects/[slug]/company/start.post.ts:215](../../server/api/projects/%5Bslug%5D/company/start.post.ts#L215))
and an off-by-default proxy mode keyed off `COMPANY_CLAUDE_PROXY_URL`.
Everything is global env, nothing is user-managed at runtime.

## Status quo (relevant parts)

- **Auth read sites:** `nuxt.config.ts` (runtimeConfig) → consumed in
  `start.post.ts:201-217`. Per-project secrets in
  `server/utils/secrets-store.ts` (AES-256-GCM, master key in
  `<dataDir>/master.key` or `SPECIFYR_SECRET_KEY` env).
- **haex-claude-proxy** is wired via `runtimeConfig.companyClaudeProxyUrl`.
  When set, `start.post.ts` overrides `ANTHROPIC_BASE_URL` and injects a
  dummy `sk-ant-api03-proxy0000...` key so hermes treats it as
  api-key auth.
- **Provider abstraction** ([src/providers/base.js](../../src/providers/base.js))
  exists (`ModelProvider`, `LocalTemplateProvider`,
  `OpenAICompatibleProvider`) but is **not active** in the runner path —
  hermes/claude-code/acp runners spawn child processes that talk to
  the LLM directly via env-vars.
- **Frontend:** per-project secrets page exists at
  `app/pages/specs/[slug]/secrets.vue`. No global settings page,
  no settings layout, no settings nav entry.

## Out of scope

- Multi-tenant: today specifyr is a single-user local tool. The settings
  page is global per install — no per-user auth.
- Per-project provider override.
- Cost / usage tracking.
- Activating the `OpenAICompatibleProvider` class in the runner path —
  that's a separate refactor.

## Design

### Storage

Add `server/utils/provider-settings-store.ts` next to `secrets-store.ts`,
reusing the same master-key + AES-GCM pattern.

```
<dataDir>/settings/providers.json
{
  "anthropic": {
    "enabled": true,
    "mode": "proxy",          // "api_key" | "proxy"
    "apiKey": { iv, tag, data },     // encrypted; absent if mode=proxy
    "proxyUrl": "http://haex-claude-proxy:8080",
    "defaultModel": "claude-sonnet-4-6"
  },
  "openai": {
    "enabled": false,
    "mode": "api_key",
    "apiKey": { iv, tag, data },
    "defaultModel": "gpt-5"
  },
  "google": {
    "enabled": false,
    "mode": "api_key",
    "apiKey": { iv, tag, data },
    "defaultModel": "gemini-2.5-pro"
  }
}
```

### API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/settings/providers` | — | `{ [provider]: { enabled, mode, hasKey, proxyUrl?, defaultModel?, status? } }` — never returns the key itself |
| `PUT` | `/api/settings/providers/:provider` | partial config + optional `apiKey` | updated config (no key) |
| `DELETE` | `/api/settings/providers/:provider/key` | — | 204 |
| `POST` | `/api/settings/providers/:provider/test` | — | `{ ok: bool, latencyMs, error? }` — sends a 1-token ping |
| `POST` | `/api/settings/providers/anthropic/oauth/start` | — | `{ loginUrl, sessionId }` (Phase 3) |
| `GET`  | `/api/settings/providers/anthropic/oauth/status` | — | `{ state: "pending" \| "authorized" \| "expired" }` (Phase 3) |

### Runtime integration

In [start.post.ts:194-225](../../server/api/projects/%5Bslug%5D/company/start.post.ts#L194-L225):

1. `const providerConfig = await loadProviderConfig()` before the
   secretsResolver factory.
2. Replace `runtimeConfig.anthropicApiKey` lookup with
   `providerConfig.anthropic.apiKey ?? projectSecrets["ANTHROPIC_API_KEY"] ?? runtimeConfig.anthropicApiKey`
   (settings page wins; project secret next; env-var as fallback).
3. If `providerConfig.anthropic.mode === "proxy"`: set
   `ANTHROPIC_BASE_URL = providerConfig.anthropic.proxyUrl` and the
   dummy api-key — keeps the existing hermes contract.
4. Same lookup for `OPENAI_API_KEY` / `GOOGLE_API_KEY` once the runners
   start consuming them.

Backward-compat: if `providers.json` is missing or `enabled: false`,
fall through to today's behavior unchanged.

### OAuth for Claude Pro/Max

Today's setup ([haex.cloud.yml: comment block on haex_claude_proxy](../../../ansible/inventory/haex.cloud.yml)):

> Pre-req: run `claude auth login` once on the server interactively
> before deploying this role.

That works but is opaque from the UI. Two flow options:

- **Phase 1 (ship now):** Settings page **does not** start the OAuth —
  it only shows status. A `GET /auth/status` endpoint added to
  `haex-claude-proxy` checks whether `~/.claude/credentials.json` is
  present + non-expired. Settings UI shows a "Logged in as ..." badge
  or a "Run `docker exec -it haex-claude-proxy claude auth login` on
  the server" hint with a copy-button. Honest, low-magic.

- **Phase 3 (later):** `haex-claude-proxy` gets a `POST /auth/start`
  endpoint that spawns `claude auth login` as a subprocess, parses
  the OAuth URL from stdout, returns it. Specifyr proxies that to the
  frontend, which opens it in a new tab. The proxy waits for the CLI
  to finish, the credentials file appears, status flips to
  `authorized`. Polling on the frontend.

  The UX win is real, but it requires changes in a separate repo
  (`haex-claude-proxy`) and adds a moving piece (subprocess lifecycle,
  timeout handling, recovery from half-finished logins). Not blocking
  the core feature.

### Frontend

- New layout `app/layouts/settings.vue` — left rail + content pane.
- New page `app/pages/settings/providers.vue` — one card per provider
  with: enabled toggle, mode select (Anthropic only), api-key input
  (masked, show/hide), proxy-URL input (Anthropic only), default-model
  combobox, "Test connection" button, status badge.
- Nav entry "Settings" in the main nav.

## Implementation phases

| Phase | Scope | Effort | Independently shippable? |
|---|---|---|---|
| 1 | Backend store + API (GET/PUT/DELETE/test), runtime integration in `start.post.ts`, frontend page + layout, nav entry. **No OAuth flow** — Anthropic still requires `docker exec` for login. | ~1.5 days | Yes — full value for OpenAI/Google + manual Claude setup. |
| 2 | Wire OpenAI / Google into the runner paths (env-var injection from settings). Provider-specific test pings. | ~0.5 day | Depends on Phase 1. |
| 3 | OAuth flow: `haex-claude-proxy` gets `/auth/start` + `/auth/status`; specifyr settings page gets login button + polling UI. | ~1 day (split across two repos) | Depends on Phase 1. |

Recommended sequence: ship Phase 1 alone, dogfood, then Phase 2/3
based on which pain shows up first.

## Open questions

1. **Per-user multi-tenant:** stays out of scope for now. Confirm.
2. **Ollama / local LLMs:** add a 4th provider entry "Custom (OpenAI-compatible)" with arbitrary `baseUrl`? Or defer until needed?
3. **Master-key reuse:** OK to share `<dataDir>/master.key` between per-project secrets and global provider settings, or split? (Reuse keeps the surface tiny; split makes "reset all secrets" vs "reset all provider keys" independent.)
4. **Default-model selection:** static list shipped with the app, or dynamic fetch from `/v1/models` per provider? Static is simpler, drifts faster.
5. **Test-connection scope:** 1-token ping is cheap but bills the user. Acceptable, or skip-by-default and only run on explicit click?
