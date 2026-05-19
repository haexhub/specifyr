# Untrusted Multi-Tenant Isolation Plan (Stufe 1 + 2)

> **Status:** ⛔ SUPERSEDED (2026-05-18). Wir verfolgen stattdessen den Browser-MCP-Ansatz:
> der LLM/Agent-Stack läuft im User-Browser, der Specifyr-Server stellt nur eine
> definierte REST-Tool-Surface bereit und führt selbst keinen Agent-Code mehr aus.
> Damit entfällt der Container-Isolations-Pfad für den Speckit-Chat komplett.
> Nachfolge-Plan: siehe `docs/plans/2026-05-18-browser-mcp-spec-agent.md`.
>
> Dokument bleibt erhalten, weil es das Server-Side-Threat-Model + Container-Design
> dokumentiert — falls wir später revertieren müssen (z.B. wenn Browser-Execution
> sich als untragbar erweist) oder ein Hermes-Runtime-Cluster auf eigener Infrastruktur
> die gleichen Isolations-Patterns braucht.
>
> Owner: tbd. Estimated effort (historisch): 2–3 weeks for Stufe 1, additional 1–2 weeks for Stufe 2.

## Goal

Mehrere Orgs hosten dieselbe Specifyr-Deployment, aber jede Org ist **prozess- und filesystem-isoliert** vom Rest. Ein böswilliger oder kompromittierter User in Org A kann unter keinen Umständen:

- Org B's Projekt-Dateien lesen oder modifizieren
- Org B's LLM-Credentials abgreifen
- Über den Specifyr-Postgres mit Org B's DB-Zeilen sprechen (über RLS hinaus)
- Über den Docker-Daemon des Hosts beliebige Container starten oder den Host selbst übernehmen

Der Schutz kommt vom **Container-Boundary**, nicht vom Permission-Prompt des Modells. Daher: `defaultMode: "bypassPermissions"` bleibt globaler Default — innerhalb des Sandboxes ist das die richtige UX-Wahl.

## Threat Model

| Angreifer | Vektor | Heutige Realität | Ziel-Zustand |
|---|---|---|---|
| Org-User mit Speckit-Chat-Zugang | Prompt-Injection → Agent ruft `Bash` mit `find /data` auf | Sieht alle Orgs' Projekt-Dateien (bind-mount geteilt) | Sieht nur eigene Org's `/workspace` |
| Org-User | Agent ruft `Bash` mit `psql ...` über `companies`-Netzwerk auf | Erreicht den geteilten Postgres-Container, RLS-Token aus env greifbar | Kein Netzwerk-Zugang zu Postgres, kein env-Leak |
| Org-User | Agent ruft `Bash` mit `docker ...` auf | `/var/run/docker.sock` ist im Specifyr-Container gemountet → effektiv Root am Host | Kein Docker-Socket im Agent-Container; Specifyr-Server selbst spricht nur mit einem schmalen Spawn-Service |
| Bug in Specifyr-App | Path-Traversal in `fs.get.ts` o.ä. | Kann theoretisch jede Org-Datei lesen | Container-Boundary fängt Traversal, Specifyr-Server hat selbst nur Lese-Zugriff auf seine Konfig + DB |

## Non-Goals

- **Kein Per-Org-Specifyr-App-Container.** Die Frontend/Orchestrator-Komponente bleibt eine geteilte Instanz. Sie hat keinen direkten User-Code-Ausführungs-Pfad, nur HTTP-Endpoints mit `project-access`-Middleware-Gating. Multi-Tenant-DB-Isolation läuft heute schon über RLS + `app.current_owner_*`-Settings.
- **Kein Wechsel weg von Postgres pro Org.** RLS in einer geteilten DB reicht für die Strukturdaten (Projekte, Sessions, Credentials-Metadaten). Sensible Felder (`oauth_credentials_data`) sind ohnehin AES-256-GCM-verschlüsselt.
- **Keine Kubernetes-Migration.** Plan bleibt Docker-Compose-kompatibel. K8s ist ein späteres Vorhaben falls Cloud-Hosting konkret wird.

---

## Stufe 1: Per-Org-Agent-Container

### Architektur-Änderung

Heute: `AcpRunner.start()` spawnt `claude-agent-acp` als **Child-Prozess** im Specifyr-Container ([src/runners/acp.js:106](src/runners/acp.js#L106)). Ziel: spawn als **Sibling-Container** pro Org/Chat-Session.

Vorlage existiert: [src/runners/hermes-docker.js](src/runners/hermes-docker.js) macht genau das für die Company-Runtime-Agents schon. Pattern hochziehen.

```
┌──────────────────────────────────────────────┐
│  specifyr (orchestrator)                     │
│  - HTTP API, Auth, DB, SSE                   │
│  - KEIN claude-agent-acp mehr als Child      │
│  - Spawned per chat session:                 │
└───┬──────────────────────────────────────────┘
    │ docker run (heute direkt; Stufe 2: über runtime-API)
    ▼
┌──────────────────────────────────────────────┐
│  specifyr-agent-<orgId>-<sessionId>          │
│  Image: specifyr-agent-acp:<tag>             │
│  - claude-agent-acp + claude SDK             │
│  - bind-mount: /data/projects/<org>/<slug>   │
│    → /workspace                              │
│  - volume:    agent-state-<orgId>            │
│    → /home/node/.claude                      │
│  - network:   agent-<orgId>-net (allow:      │
│    claude-proxy only)                        │
│  - env:       NUR die credentials für        │
│    diese Org's Speckit-Profil                │
│  - kein /var/run/docker.sock                 │
│  - resource limits: 1 CPU, 2 GiB RAM         │
└──────────────────────────────────────────────┘
```

### Konkrete Komponenten

1. **`docker/agent/Dockerfile`** — neues, minimales Image:
   - `node:22-alpine`
   - `@agentclientprotocol/claude-agent-acp` pinned auf eine Version
   - Keine Specifyr-Code-Dependencies
   - `USER node`, `WORKDIR /workspace`
   - Image-Tag: `ghcr.io/haexhub/specifyr-agent-acp:<version>`

2. **`src/runners/acp-docker.js`** — neuer Runner, **gleiches Interface** wie `AcpRunner`:
   - `start({ resumeSessionId })` → `docker run -d -i ...` + warten bis ACP-init returnt
   - `prompt({ prompt, onEvent })` → ACP über `docker attach`'s stdio
   - `close()` → `docker stop` + `docker rm`
   - `isAlive()` → `docker inspect` für status
   - `cancel()` → ACP `session/cancel` Notification

3. **`server/shared/utils/speckit-agent-runner.ts`** — Factory switched für `acp:*` Runner-Keys auf `AcpDockerRunner`. Andere Runner-Keys (codex, gemini) zunächst beim Child-Process-Pfad belassen, bis ihre Images existieren.

4. **`server/plugins/drain-turn-broker.ts`** — bestehender Shutdown-Hook erweitern: nicht nur in-memory `sessions`-Map drainen, sondern auch zugehörige Container stoppen.

5. **Netzwerk-Setup**: 
   - Per-Org-Bridge-Network `agent-<orgId>-net`, on-demand erstellt beim ersten Spawn der Org
   - Claude-Proxy in jedes Org-Network gleichzeitig (multi-network-attach), oder Proxy hinter einem Loadbalancer
   - Specifyr-Server kann NICHT in diese Networks → kein Bypass über Backend-API

6. **Volume-Naming**: 
   - Format: `specifyr-agent-state-<orgId-hex>`
   - Specifyr-Server orchestriert Erstellung über Spawn-API
   - Cleanup-Policy: Volume bleibt bestehen wenn Container weg ist (für `loadSession` über Restart hinweg)

### Migration Tasks

- **Task 1.1** Image bauen + in CI publishen. Tests: `claude-agent-acp --version` im Image.
- **Task 1.2** `AcpDockerRunner` implementieren. Wiederverwende die Test-Suite von `tests/runners/acp-runner-keepalive.test.js` — gleiches Interface = gleiche Tests passen.
- **Task 1.3** Network-Manager: pro Org auf demand network erstellen. Migration-Test: zwei Orgs parallel, kein Cross-Reach.
- **Task 1.4** Volume-Manager: per-Org `~/.claude`-Volumes, `loadSession` über Container-Recreate hinweg verifizieren.
- **Task 1.5** Specifyr-Compose anpassen: `claude-agent-acp` aus dem Specifyr-Image entfernen (im Agent-Image), Specifyr-Container braucht es selbst nicht mehr.
- **Task 1.6** Resource-Limits + Cleanup-Job: idle Container nach 30 min stoppen, dead-Container-GC.

### Migrations-Strategie

Backwards-compat während des Übergangs:
1. Initial: Stufe 1 als optionaler Mode hinter env-Flag `SPECIFYR_AGENT_ISOLATION=container` (default `process`).
2. Beta-Test: einzelne Orgs migrieren, performance + UX-Impact messen.
3. Switch: default auf `container`, alter `process`-Pfad bleibt für Dev/Single-User-Setups verfügbar (z.B. `pnpm dev` ohne Docker-in-Docker-Komplexität).
4. Cleanup: `process`-Pfad entfernen sobald alle Production-Deployments migriert sind.

### Risks & Open Questions

- **Container-Spawn-Latenz**: heute Child-Process-Spawn ~50ms, Container ~1-2s. UX: erster Turn fühlt sich langsamer an. Mitigation: pre-warm-Pool pro Org möglich, aber zusätzlicher Komplexität-Layer.
- **claude-agent-acp ist not-OCI**: das npm-Package läuft als CLI, kein offizielles Anthropic-Container-Image. Wir maintainen das Image selbst (Versions-Tracking + CVE-Updates).
- **Multi-Network-Attach für claude-proxy**: einfacher wäre claude-proxy in einem dedizierten Network und Org-Agents `--add-host` → Proxy. Aber dann erreicht Org A vielleicht Proxy-Anwort von Org B's Request via Side-Channels. **Cleaner**: separate proxy-Instanz pro Org, oder ein Auth-Proxy der pro Request der Specifyr-API gegen-verifiziert dass der Token zur richtigen Org gehört.
- **Speckit-Company-Workflow**: die Company-Runtime spawnt heute schon eigene Hermes-Agent-Container. Zwei parallele Container-Spawn-Pfade ist suboptimal. Stufe 1 sollte den Hermes-Pfad gleich mitmigrieren.

---

## Stufe 2: Kein Docker-Socket im Specifyr-Container

### Architektur-Änderung

Heute hat der Specifyr-Container `/var/run/docker.sock` gemountet (siehe [docker-compose.yml](docker-compose.yml), [docker-compose.prod.yml](docker-compose.prod.yml), [ansible/roles/specifyr/templates/docker-compose.yml.j2](https://github.com/haexhub/ansible/blob/master/roles/specifyr/templates/docker-compose.yml.j2)). Eine Code-Execution-Vulnerability im Specifyr-Server selbst = Root am Host. Auch nach Stufe 1, wenn der Specifyr-Server selbst die Spawn-Calls macht.

**Ziel**: Specifyr-Server hat keinen direkten Daemon-Zugriff mehr. Alle Container-Operationen gehen über einen schmalen Spawn-Service mit klar definierten, gewhitelisteten Operations.

```
┌─────────────────────┐         ┌─────────────────────┐
│ specifyr (app)      │ HTTPS+  │ specifyr-runtime    │
│ - kein docker.sock  │ mTLS    │ - hat docker.sock   │
│ - ruft schmale API  ├────────►│ - validiert + spawnt │
│   /agents POST      │         │ - exposed nur 4 APIs│
└─────────────────────┘         └─────────────────────┘
                                          │
                                          │ docker run
                                          ▼
                                ┌──────────────────────┐
                                │ agent containers      │
                                │ (Stufe 1 layout)      │
                                └──────────────────────┘
```

### Spawn-Service-API

Schmal halten — nur diese vier Endpoints:

| Endpoint | Was es macht | Validierung |
|---|---|---|
| `POST /agents` | Spawn-Agent-Container für (orgId, projectSlug, image, env) | image in Registry-Allowlist; orgId existiert in DB; project-mount-Pfad ist `/data/projects/<orgId>/<slug>` und nichts anderes; env-Keys gegen Allowlist |
| `DELETE /agents/<id>` | Container stoppen + entfernen | id-Owner muss aufrufende Specifyr-App-Instance sein |
| `GET /agents/<id>` | Status / isAlive | derselbe ownership check |
| `POST /agents/<id>/stdio` | Pipe attach (für ACP-Verbindung) | dito |

**Was NICHT exposed wird**: arbitrary `docker run`, image pulls, volume manipulation außerhalb der allowed-Patterns, host-Bind-Mounts außerhalb `/data/projects`, network creation außerhalb `agent-<orgId>-net`-Pattern.

### Auth zwischen Specifyr-App und Spawn-Service

- **mTLS** mit private CA, beide Container haben ihr eigenes Cert. Zertifikats-Rotation via Ansible/Compose-Init.
- Spawn-Service signiert/loggt jeden Request mit dem (validated) orgId — Audit-Trail.

### Migration Tasks

- **Task 2.1** `specifyr-runtime`-Container Skeleton (Go oder Node, klein, ohne ORM/DB)
- **Task 2.2** mTLS-Setup (CA + Cert-Generation in Ansible)
- **Task 2.3** Spawn-API + Tests: malicious-input scenarios (mount-pfad-traversal, image-allowlist-bypass, env-injection)
- **Task 2.4** Client-Lib in Specifyr-App: ersetze direct-Docker-API-calls in `AcpDockerRunner` + `hermes-docker.js`
- **Task 2.5** docker.sock-Mount aus Specifyr-Compose entfernen, Service-Discovery anpassen

### Risks

- **Specifyr-Runtime ist neue Angriffsoberfläche**. Muss minimal bleiben, kein User-Input rendern, kein DB-Zugriff, keine Login-API.
- **Operational Komplexität**: zusätzliche Service in Compose, separate CI-Pipeline für das Image, mTLS-Cert-Management.

---

## Zusammenhängende Themen (außerhalb dieses Plans)

- **`/var/run/docker.sock` weg auch für die Specifyr-App im Dev-Stack** — heute wird der Socket schon im Dev-Compose gemountet. Stufe 2 lokal nachzustellen heißt auch dev.sh anzupassen. Vorschlag: Stufe 1 erstmal nur in Prod ausrollen, dev bleibt Process-Mode.
- **Per-Org-Backups**: mit per-Org-Volumes wird Backup-Strategie konkreter — `agent-state-<orgId>` Snapshots eignen sich gut für Org-Export/Migration zu eigener Specifyr-Instanz.
- **Rate-Limiting an der Spawn-API**: ein Loop in Org A's Code könnte 10000 Container/Sek spawnen wollen. Hard quota pro Org an der Spawn-API.

## Definition of Done

- Untrusted-Multi-Tenant-Repro-Test: Pen-Test-Script in `tests/security/`, das aus Org A's Speckit-Chat versucht:
  - `find /data` (sollte nur eigenes `/workspace` sehen)
  - `nc -z postgres 5432` (sollte timeout / unreachable sein)
  - `cat /run/secrets/*` (sollte leer / org-scoped sein)
  - `curl http://specifyr-runtime:8080/agents` ohne mTLS (sollte 401)
  Jeder dieser Probes wird in CI ausgeführt und MUSS failen (in der Org-A-Perspektive = isoliert sein).
- Performance: erster Turn-Start in < 3 sec end-to-end (vs heute ~500 ms im Process-Mode).
- Specifyr-Server-Compose hat keinen `docker.sock`-Mount mehr.
