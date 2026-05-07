# Handoff: Deploy v0.5.0 + offene Punkte

**Stand:** 2026-05-08
**Vorgänger:** [2026-05-07-handoff-phase-5-and-7.md](./2026-05-07-handoff-phase-5-and-7.md)

Phasen 5–9 (multi-tenant LLM auth) sind code-complete + auf main in
allen drei Repos. Was diese Session noch nicht erledigt hat, steht
unten.

## Was bereits durch ist

| Phase | Inhalt | Repo / Branch | Status |
|---|---|---|---|
| 5 | Org-shared LLM credentials + project owner-org | specifyr/main | ✅ pushed |
| 6 | runner_sessions Tabelle + oauth_claude resolver | specifyr/main | ✅ pushed |
| 7 | Multi-tenant proxy + ansible config | proxy/main + ansible/master | ✅ merged (PR #8) |
| 8 | Personal Claude OAuth flow | specifyr/main | ✅ pushed |
| 9 | Org Claude OAuth flow | specifyr/main | ✅ pushed |

**Release:** specifyr v0.5.0 wurde getaggt (PR #13 gemerged). Build
#26 (workflow_dispatch auf v0.5.0) lief beim Verlassen der Session
noch — wenn du das hier liest, ist er entweder durch oder hängt
ähnlich wie #23 (das war unklarer Buildx/QEMU-Hänger; #25 dasselbe
Commit hatte 13:53 gebraucht).

## Akut: Deploy v0.5.0 auf haex.cloud

Aktuell läuft auf prod noch `ghcr.io/haexhub/specifyr:latest @ d287454`
(= v0.4.0). Die Multi-tenant-Architektur ist also noch nicht live.

**Reihenfolge** (nicht umstellen — neuer specifyr braucht den neuen
proxy-Mount):

1. ✅ ansible PR #8 ist gemerged → master hat die neuen
   `/credentials`-Mounts + DATABASE_URL für den proxy.
2. ⏳ specifyr v0.5.0 Image-Build muss durch sein:
   ```bash
   gh run list --repo haexhub/specifyr --workflow "Build specifyr image" --limit 3
   ```
3. ⏳ proxy hatte zuletzt einen Phase-7-Push. Build-Status:
   ```bash
   gh run list --repo haexhub/haex-claude-proxy --limit 3
   ```
4. **ansible-playbook** auf haex.cloud:
   ```bash
   cd /home/haex/Projekte/ansible
   git checkout master && git pull
   ansible-playbook -i inventory/haex.cloud.yml haex.cloud.play.yml \
     --tags haex-claude-proxy,specifyr
   ```
   Das re-rendert beide compose-files, recreated die Container und
   pulled `:latest` mit. `gh auth switch --user haexhub` falls nötig.
5. **Watchtower-Refresh** (optional, ansible-recreate erledigt das schon):
   ```bash
   ssh haex.cloud "docker kill -s USR1 watchtower"
   ```
6. **Smoke-checks** auf prod:
   - `/api/me` als logged-in user → 200 mit User-Daten
   - `/settings/me/llm` rendert, "Sign in with Claude"-Button da
   - Bestehender Anthropic API-Key Flow funktioniert weiter (kein
     Breaking Change auf api_key-Pfad)
   - Eine Org anlegen, `/settings/orgs/<slug>/llm` rendert
   - DB hat die `runner_sessions` Tabelle (autom. via migration 0005)

**Rollback:** Image-Pin im ansible inventory auf
`specifyr.image_tag: 0.4.0` und `haex_claude_proxy.image_tag: <vorheriger sha>`,
playbook erneut. DB-Migration 0005 ist additiv (nur `CREATE TABLE`
+ `CREATE INDEX`), kein automatisches down. Wenn nötig manuell:
`DROP TABLE runner_sessions;` — keine andere Tabelle hängt davon ab.

## PR #7 (authentik) — nicht in dieser Session bearbeitet

Vorhandene Arbeit an [feat/authentik-replace-authelia](https://github.com/haexhub/ansible/pull/7).
Hat 8 CodeRabbit-Findings, davon einige relevant. Wurde bewusst
nicht angefasst weil:
- es nicht aus den Phasen 5–9 stammt
- PR #7 berührt `roles/specifyr/templates/docker-compose.yml.j2`
  und PR #8 (jetzt gemerged) auch — bei einem Re-base auf master
  gibt es einen Konflikt beim `/credentials`-Mount, den die nächste
  Session lösen muss.

**Findings auf PR #7 die direkt valid wirken:**
- `roles/postgres/files/.../create_authentik_db.sql:9` — hardcoded
  DB-Name driftet von `authentik.database_name` weg
- `roles/authentik/templates/docker-compose.yml.j2:39` und `:80` —
  zwei separate Issues (CodeRabbit hat sie nicht ausführlich
  gezeigt, müsste man nochmal ziehen mit `gh api`)
- `roles/authentik/tasks/main.yml:90` — `recreate: always` löst
  unnötige Auth-Outages aus

**Findings die "heavy lift" sind und Diskussion brauchen:**
- authentik läuft mit postgres admin creds (gleiches Thema wie
  beim proxy in PR #8)
- `roles/authentik/templates/blueprints/specifyr-proxy.yaml.j2:60`
  — heavy lift, vermutlich Provider-Konfig

**Empfohlene Reihenfolge:**
1. Auf PR #7 master rebasen (PR #8 ist drin) — Konflikt im specifyr
   docker-compose.yml.j2 lösen.
2. Quick-win findings adressieren.
3. Heavy-lift findings: Entscheidung dazu zusammen mit dem
   "least-priv DB user"-Thema (siehe unten unter Sicherheit) als
   eigenes Mini-Projekt angehen.

## Sicherheits-Schuld: per-app DB users

Aktueller Stand: sowohl `haex-claude-proxy` als auch `authentik`
verbinden mit den postgres-admin-creds (`secrets.postgres.admin`).
Code-Review von beiden PRs hat das angemerkt.

**Was nötig wäre:**
1. Auf der `postgres`-Rolle einen Mechanismus zum Anlegen von
   per-app users via `roles/postgres/files/docker-entrypoint-initdb.d/`
   oder einer separaten ansible task.
2. Pro app:
   - `haex_claude_proxy_db`: SELECT auf `runner_sessions`. Read-only.
   - `authentik_db`: vermutlich `ALL` auf der `authentik` DB
     (das macht authentik zu deren admin, aber nicht zu postgres-
     admin überall).
3. Secrets-File-Layout erweitern: `secrets.postgres.proxy.{user,password}`,
   `secrets.postgres.authentik.{user,password}`.
4. defaults der jeweiligen Rolle auf die neuen Secrets umstellen.

**Effort:** ~0.5d, mit Sorgfalt für Idempotenz beim user-create
(IF NOT EXISTS) und mit Migration-Path für das aktuelle setup
(also: alter user create + grants, ohne den alten admin-user-Fallback
sofort zu killen — sonst breaking deploy).

## Live-OAuth-Test (Phase 8/9)

Die fake-claude-Stub-Tests decken den Subprocess-Mechanismus in CI
ab, aber der echte `claude auth login` flow wurde diese Session
nicht live ausgeführt — bei einem fehlgeschlagenen Probelauf wurde
deine bestehende prod-Session bei Anthropic invalidiert (User-Hint
in der Session vom 07.05.).

**Voraussetzung für sicheren Live-Test:**
- Eigener Anthropic-Test-Account mit OAuth, dessen Session-Verlust
  egal ist
- Oder: dedicated test-environment auf z.B. einer zweiten
  haex.cloud-Subdomain mit eigener Postgres-Instanz

**Was getestet werden muss, sobald die Test-Umgebung steht:**
1. `/settings/me/llm` → "Login with Claude" → Browser-Tab → Code
   pasten → "Connected" Status erscheint
2. `<dataDir>/credentials/user/<userId>/.claude/.credentials.json`
   liegt mit korrektem `expiresAt` auf der Disk
3. Org-OAuth: Admin in org, gleicher Flow am `/settings/orgs/<slug>/llm`
4. Member sieht "Connected"-Status (read-only) ohne Login-Button
5. Agent-Run im Org-owned project mit oauth-only credentials →
   `start.post.ts` mintet ein runner_session, hermes ruft den proxy
   mit dem Token auf, proxy resolved es, claude CLI spawnt mit
   `HOME=/credentials/org/<id>`, Antwort kommt zurück

**Failure modes die explizit zu testen sind:**
- Token expired (DB row aber `expires_at < now`) → proxy 401
- Token revoked → proxy 401
- credentials.json fehlt → proxy 502 (claude CLI exit !=0)

## Backlog / Deferred (nicht akut)

- **Self-Registration via Authentik** — Blueprint-Konfig fehlt;
  akadmin muss aktuell jeden user manuell anlegen. Companion zum
  bereits geshippten Org-Invite-Flow.
- **Stripe / Billing** — Phase B in der SaaS-Roadmap, nicht
  detailliert geplant.
- **Project-Transfer-UI** — Phase 5 löst owner-org bei Create,
  nachträglicher Transfer ist eigene Sprint.
- **Token-Refresh-UX** — wenn `oauth_claude.expiresAt` abgelaufen
  ist, refresht der CLI selbst beim nächsten run (RW-Mount), aber
  das UI zeigt das nicht. User sieht "Connected" obwohl Token in
  DB als expired markiert wäre.
- **Proxy-Performance** — pro hermes-request ein
  `runner_sessions` Lookup. Wenn das messbar wird, lru-cache mit
  5min TTL davorschalten. Heute nicht relevant.
- **Cleanup-Cron für expired runner_sessions** — `pruneExpired`
  ist implementiert, aber nirgends regelmäßig aufgerufen. Auf prod
  als Nitro-Cron-Plugin oder via systemd.timer einbauen sobald die
  Tabelle realistisch wächst.

## Quick-start incantations

```bash
# specifyr dev
docker run -d --rm --name pg -p 5566:5432 \
  -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=specifyr postgres:alpine
pnpm dev   # liest .env

# Tests
pnpm test       # 380 unit, ~23s
pnpm test:e2e   # 26 api-e2e, ~40s

# Production-Deploy nach release-PR-Merge
gh auth switch --user haexhub
gh pr merge <N> --repo haexhub/specifyr --squash --delete-branch
# warten bis "Build specifyr image" workflow grün ist
ansible-playbook -i inventory/haex.cloud.yml haex.cloud.play.yml \
  --tags haex-claude-proxy,specifyr

# Status-Check auf prod
ssh haex.cloud "docker inspect specifyr --format '{{.Config.Image}}: {{.Created}}'"
ssh haex.cloud "docker logs specifyr --tail 30 2>&1 | grep -i 'migration\\|listening'"
```

## Pitfalls für die nächste Session

- **`gh auth switch --user haexhub`** vor dem Mergen oder Pushen
  in haexhub-repos. Default-Account auf diesem Host ist `haex-space`
  (kein Schreibrecht).
- **Ansible-Edits gehen nicht direkt auf master** — feature branch
  + PR. Hook blockiert direkten master-Push.
- **Build-Workflow QEMU-arm64-Builds können extrem hängen** —
  einzelne Runs > 1h sahen wir in dieser Session (Run #23 hängte
  bei `Build and push (prod target)`). Watchen, ggf. cancel +
  re-run.
- **Phase-8-OAuth-Live-Tests können bestehende Anthropic-
  Sessions invalidieren** — siehe oben "Live-OAuth-Test".
