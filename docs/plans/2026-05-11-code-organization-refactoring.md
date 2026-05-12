# Code-Organisation und Modulstruktur Refactoring

## Analyse der aktuellen Architektur

### Identifizierte Probleme

#### 1. Inkonsistente Verzeichnisstrukturen

- **Backend**: Mischung aus `src/` (CLI/Core) und `server/` (Nuxt API)
- **Frontend**: Komponenten in `app/components/` ohne klare Kategorisierung
- **Utils**: Doppelte Utility-Funktionen in `src/utils/` und `server/utils/`

#### 2. Unklare Trennung von Verantwortlichkeiten

- **Orchestrator-Klasse**: Zu viele Verantwortlichkeiten (409 Zeilen)
- **Core-Module**: Starke Kopplung zwischen verschiedenen Domänen
- **Server-Utils**: Vermischung von Datenbank-, Auth- und Business-Logik

#### 3. Inkonsistente Namenskonventionen

- **Dateien**: Mischung aus kebab-case und camelCase
- **Klassen**: Inkonsistente Suffixe (Store, Service, Manager)
- **Imports**: Relative Pfade ohne klare Struktur

#### 4. Fehlende Kapselung

- **Direkte Abhängigkeiten**: Core-Module importieren direkt aus anderen Domänen
- **Keine Barrel-Exports**: Interne Implementierungsdetails sind exponiert
- **Zirkuläre Abhängigkeiten**: Potenzielle Probleme durch starke Kopplung

### Aktuelle Modulstruktur

```
src/
├── cli/           # CLI-Commands
├── core/          # Kerngeschäftslogik (17 Module)
├── acp/           # Agent Communication Protocol
├── agents/        # Agent-Spezifikationen
├── providers/     # LLM-Provider
├── runners/       # Agent-Runner
├── transports/    # Notification-Transports
├── utils/         # Utility-Funktionen
└── server/        # HTTP-Server

server/
├── api/           # Nuxt API-Routen
├── db/            # Datenbank-Schema und Client
├── middleware/    # Server-Middleware
├── plugins/       # Nuxt-Plugins
└── utils/         # Server-Utilities (20+ Module)

app/
├── components/    # Vue-Komponenten (30+ Komponenten)
├── pages/         # Nuxt-Pages
├── layouts/       # Layouts
├── composables/   # Vue-Composables
└── lib/           # Frontend-Utilities
```

## Vorgeschlagene neue Modulstruktur

### 1. Domain-Driven Design Ansatz (Backend)

```
src/
├── domains/
│   ├── auth/
│   │   ├── services/
│   │   ├── stores/
│   │   └── index.ts
│   ├── projects/
│   │   ├── services/
│   │   ├── stores/
│   │   ├── models/
│   │   └── index.ts
│   ├── agents/
│   │   ├── services/
│   │   ├── runners/
│   │   ├── models/
│   │   └── index.ts
│   ├── orchestration/
│   │   ├── services/
│   │   ├── workflows/
│   │   └── index.ts
│   └── llm/
│       ├── providers/
│       ├── credentials/
│       └── index.ts
├── shared/
│   ├── infrastructure/
│   │   ├── database/
│   │   ├── filesystem/
│   │   ├── events/
│   │   └── config/
│   ├── utils/
│   └── types/
├── cli/
└── server/
```

### 2. Frontend-Reorganisation (Vue/Nuxt Best Practices)

```
app/
├── components/
│   ├── ui/              # Custom UI-Komponenten (basierend auf shadcn)
│   ├── shadcn/          # Reine shadcn/reka-ui Komponenten
│   ├── layout/          # Layout-spezifische Komponenten
│   ├── auth/            # Auth-bezogene Komponenten
│   ├── projects/        # Projekt-bezogene Komponenten
│   ├── agents/          # Agent-bezogene Komponenten
│   ├── settings/        # Settings-bezogene Komponenten
│   └── common/          # Wiederverwendbare Komponenten
├── composables/
│   ├── auth/            # useAuth, useLogin, etc.
│   ├── projects/        # useProjects, useProjectDetail, etc.
│   ├── agents/          # useAgents, useAgentProfiles, etc.
│   ├── settings/        # useSettings, useOrgSettings, etc.
│   └── core/            # useApi, useNotifications, etc.
├── stores/              # Pinia Stores (falls verwendet)
│   ├── auth.ts
│   ├── projects.ts
│   ├── agents.ts
│   └── settings.ts
├── utils/
│   ├── api.ts           # API-Utilities
│   ├── validation.ts    # Validierungs-Utilities
│   ├── formatting.ts    # Format-Utilities
│   └── constants.ts     # App-weite Konstanten
├── types/
│   ├── auth.ts          # Auth-bezogene Types
│   ├── projects.ts      # Projekt-bezogene Types
│   ├── agents.ts        # Agent-bezogene Types
│   └── api.ts           # API-Response Types
├── pages/               # Nuxt Auto-Routing
├── layouts/             # Nuxt Layouts
├── middleware/          # Nuxt Middleware
├── plugins/             # Nuxt Plugins
└── assets/              # Statische Assets
```

**Komponenten-Struktur Details:**

- **`components/ui/`**: Custom UI-Komponenten die auf shadcn aufbauen oder komplett custom sind
  - `DataTable.vue` (erweitert shadcn Table)
  - `FormField.vue` (custom Form-Wrapper)
  - `StatusBadge.vue` (custom Badge-Varianten)

- **`components/shadcn/`**: Reine shadcn/reka-ui Komponenten ohne Modifikationen
  - `button/`, `card/`, `dialog/`, etc.
  - Direkt aus shadcn-vue generiert

**Warum funktionsbasiert statt domänenbasiert?**

1. **Nuxt-Konventionen**: Auto-Imports funktionieren besser mit funktionsbasierter Struktur
2. **Vue-Ökosystem**: Etablierte Patterns in der Community
3. **Entwicklererfahrung**: Einfacher zu navigieren für Vue-Entwickler
4. **Tool-Support**: Bessere IDE-Unterstützung und Linting

### 3. Server-Reorganisation (Flache Struktur)

```
server/
├── auth/
│   ├── api/             # Auth API-Routen
│   ├── services/        # Auth Services
│   └── middleware/      # Auth Middleware
├── projects/
│   ├── api/             # Projekt API-Routen
│   └── services/        # Projekt Services
├── agents/
│   ├── api/             # Agent API-Routen
│   └── services/        # Agent Services
├── admin/
│   ├── api/             # Admin API-Routen
│   └── services/        # Admin Services
├── settings/
│   ├── api/             # Settings API-Routen
│   └── services/        # Settings Services
├── shared/
│   ├── database/        # DB Client und Schema
│   ├── validation/      # Validierungs-Utilities
│   ├── middleware/      # Gemeinsame Middleware
│   └── utils/           # Server-Utilities
└── plugins/             # Nuxt Server-Plugins
```

**Vorteile der flachen Server-Struktur:**

- Einfachere Navigation ohne zusätzliche Verschachtelung
- Klare Trennung nach Funktionsbereichen
- Bessere Übersicht bei API-Routen
- Konsistent mit Nuxt-Konventionen

## Namenskonventionen

### Dateien und Verzeichnisse

- **Verzeichnisse**: kebab-case (`auth-service`, `llm-providers`)
- **Dateien**: kebab-case mit Suffix (`user-store.ts`, `auth-service.ts`)
- **Komponenten**: PascalCase (`UserProfile.vue`, `ProjectCard.vue`)
- **Composables**: camelCase mit `use` Prefix (`useAuth.ts`, `useProjects.ts`)

### Klassen und Interfaces

- **Services**: `*Service` (`AuthService`, `ProjectService`)
- **Stores**: `*Store` (`UserStore`, `ProjectStore`)
- **Models**: Ohne Suffix (`User`, `Project`, `Agent`)
- **Interfaces**: `I*` Prefix (`IUserRepository`, `IAuthProvider`)
- **Composables**: `use*` (`useAuth`, `useProjects`)

### Imports und Exports

- **Barrel Exports**: Jede Domäne hat eine `index.ts`
- **Auto-Imports**: Nuxt Auto-Import für Composables nutzen
- **Named Exports**: Bevorzugt gegenüber Default Exports

## Refactoring-Schritte

### Phase 1: Frontend reorganisieren (Vue/Nuxt Best Practices)

1. **Komponenten kategorisieren**:
   - Shadcn-Komponenten nach `components/shadcn/`
   - Custom UI-Komponenten nach `components/ui/`
   - Domänen-Komponenten nach `components/{domain}/`
   - Layout-Komponenten nach `components/layout/`

2. **Composables strukturieren**:
   - Auth-Logik in `composables/auth/`
   - Projekt-Logik in `composables/projects/`
   - Core-Utilities in `composables/core/`

3. **Types organisieren**:
   - Domänen-spezifische Types in `types/{domain}.ts`
   - API-Types in `types/api.ts`

4. **Utils konsolidieren**:
   - API-Utilities in `utils/api.ts`
   - Validierung in `utils/validation.ts`

### Phase 2: Server refactoring (Flache Struktur)

1. **API-Routen nach Domänen gruppieren**:
   - Auth-Routen nach `server/auth/api/`
   - Projekt-Routen nach `server/projects/api/`
   - Admin-Routen nach `server/admin/api/`

2. **Services extrahieren**:
   - Auth-Services nach `server/auth/services/`
   - Projekt-Services nach `server/projects/services/`

3. **Shared-Module konsolidieren**:
   - Database-Code nach `server/shared/database/`
   - Validation nach `server/shared/validation/`
   - Utils nach `server/shared/utils/`

### Phase 3: Infrastruktur vorbereiten

1. Neue Verzeichnisstruktur erstellen
2. Path-Mapping in `tsconfig.json` konfigurieren
3. Barrel-Export-Dateien erstellen
4. Auto-Import-Konfiguration für Composables

### Phase 4: Shared-Module migrieren

1. Utility-Funktionen konsolidieren
2. Gemeinsame Types definieren
3. Infrastructure-Services extrahieren

### Phase 5: Domain-Module erstellen (Backend)

1. Auth-Domäne extrahieren
2. Project-Domäne reorganisieren
3. Agent-Domäne strukturieren
4. LLM-Domäne isolieren

### Phase 6: Orchestrator aufteilen

1. Workflow-Services extrahieren
2. Command-Handler isolieren
3. Event-System implementieren

## Moderne Vue/Nuxt Patterns

### Composables Pattern

```typescript
// composables/auth/useAuth.ts
export const useAuth = () => {
  const user = ref<User | null>(null);

  const login = async (credentials: LoginCredentials) => {
    // Login-Logik
  };

  const logout = async () => {
    // Logout-Logik
  };

  return {
    user: readonly(user),
    login,
    logout,
  };
};
```

### Custom UI Component Pattern

```vue
<!-- components/ui/DataTable.vue -->
<template>
  <div class="rounded-md border">
    <Table>
      <TableHeader>
        <!-- Custom Header Logic -->
      </TableHeader>
      <TableBody>
        <!-- Custom Body Logic -->
      </TableBody>
    </Table>
  </div>
</template>

<script setup lang="ts">
// Importiert shadcn-Komponenten
import { Table, TableHeader, TableBody } from "~/components/shadcn/table";

// Custom Logic für erweiterte Funktionalität
</script>
```

### Server API Structure

```typescript
// server/auth/api/login.post.ts
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const authService = new AuthService();

  return await authService.login(body);
});
```

### Auto-Import Konfiguration

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  imports: {
    dirs: ["composables/**", "utils/**"],
  },
  components: [
    {
      path: "~/components",
      pathPrefix: false,
    },
  ],
});
```

## Vorteile der neuen Struktur

### Bessere Wartbarkeit

- Klare Trennung zwischen shadcn und custom Komponenten
- Flache Server-Struktur für bessere Navigation
- Reduzierte Kopplung zwischen Modulen

### Verbesserte Entwicklererfahrung

- Konsistente Namenskonventionen
- Vorhersagbare Dateistrukturen
- Bessere IDE-Unterstützung durch TypeScript
- Auto-Imports reduzieren Boilerplate

### Skalierbarkeit

- Neue Features können einfach hinzugefügt werden
- Team-basierte Entwicklung wird erleichtert
- Code-Wiederverwendung wird gefördert

## Migrationsplan

### Risikoanalyse

- **Niedrig**: Komponenten-Reorganisation und Utility-Funktionen
- **Mittel**: Server-Umstrukturierung und Composables
- **Hoch**: Orchestrator-Aufspaltung und Domain-Extraktion

### Rollback-Strategie

- Schrittweise Migration mit Git-Branches
- Parallele Implementierung für kritische Komponenten
- Umfassende Tests vor jeder Änderung

### Zeitplan

- **Woche 1**: Frontend-Reorganisation (Komponenten + Composables)
- **Woche 2**: Server-Umstrukturierung (flache Struktur)
- **Woche 3**: Shared-Module und Infrastructure
- **Woche 4-5**: Domain-Module (Backend)
- **Woche 6**: Orchestrator-Aufspaltung
- **Woche 7**: Testing und Dokumentation

## Nächste Schritte

1. **Stakeholder-Review**: Plan mit Team besprechen
2. **Frontend-Prototyping**: Komponenten-Reorganisation als Proof-of-Concept
3. **Server-Struktur**: Flache API-Struktur implementieren
4. **Auto-Import Setup**: Nuxt-Konfiguration für neue Struktur
5. **Migration**: Schrittweise Umsetzung beginnen
