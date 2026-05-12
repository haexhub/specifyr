# Architektur-Diagramme für Code-Reorganisation

## Aktuelle vs. Neue Struktur

### Frontend-Architektur (Neue Struktur)

```mermaid
graph TD
    A[app/] --> B[components/]
    A --> C[composables/]
    A --> D[utils/]
    A --> E[types/]
    A --> F[pages/]
    A --> G[layouts/]

    B --> B1[ui/ - Custom Components]
    B --> B2[shadcn/ - Pure shadcn]
    B --> B3[layout/ - Layout Components]
    B --> B4[auth/ - Auth Components]
    B --> B5[projects/ - Project Components]
    B --> B6[agents/ - Agent Components]
    B --> B7[settings/ - Settings Components]
    B --> B8[common/ - Shared Components]

    C --> C1[auth/ - useAuth, useLogin]
    C --> C2[projects/ - useProjects]
    C --> C3[agents/ - useAgents]
    C --> C4[settings/ - useSettings]
    C --> C5[core/ - useApi, useNotifications]

    D --> D1[api.ts]
    D --> D2[validation.ts]
    D --> D3[formatting.ts]
    D --> D4[constants.ts]

    E --> E1[auth.ts]
    E --> E2[projects.ts]
    E --> E3[agents.ts]
    E --> E4[api.ts]
```

### Server-Architektur (Flache Struktur)

```mermaid
graph TD
    A[server/] --> B[auth/]
    A --> C[projects/]
    A --> D[agents/]
    A --> E[admin/]
    A --> F[settings/]
    A --> G[shared/]
    A --> H[plugins/]

    B --> B1[api/ - Auth Routes]
    B --> B2[services/ - Auth Services]
    B --> B3[middleware/ - Auth Middleware]

    C --> C1[api/ - Project Routes]
    C --> C2[services/ - Project Services]

    D --> D1[api/ - Agent Routes]
    D --> D2[services/ - Agent Services]

    E --> E1[api/ - Admin Routes]
    E --> E2[services/ - Admin Services]

    F --> F1[api/ - Settings Routes]
    F --> F2[services/ - Settings Services]

    G --> G1[database/ - DB Client & Schema]
    G --> G2[validation/ - Validation Utils]
    G --> G3[middleware/ - Shared Middleware]
    G --> G4[utils/ - Server Utils]
```

### Backend Core-Architektur (Domain-Driven)

```mermaid
graph TD
    A[src/] --> B[domains/]
    A --> C[shared/]
    A --> D[cli/]

    B --> B1[auth/]
    B --> B2[projects/]
    B --> B3[agents/]
    B --> B4[orchestration/]
    B --> B5[llm/]

    B1 --> B1A[services/]
    B1 --> B1B[stores/]
    B1 --> B1C[index.ts]

    B2 --> B2A[services/]
    B2 --> B2B[stores/]
    B2 --> B2C[models/]
    B2 --> B2D[index.ts]

    B3 --> B3A[services/]
    B3 --> B3B[runners/]
    B3 --> B3C[models/]
    B3 --> B3D[index.ts]

    B4 --> B4A[services/]
    B4 --> B4B[workflows/]
    B4 --> B4C[index.ts]

    B5 --> B5A[providers/]
    B5 --> B5B[credentials/]
    B5 --> B5C[index.ts]

    C --> C1[infrastructure/]
    C --> C2[utils/]
    C --> C3[types/]

    C1 --> C1A[database/]
    C1 --> C1B[filesystem/]
    C1 --> C1C[events/]
    C1 --> C1D[config/]
```

## Datenfluss-Diagramm

```mermaid
sequenceDiagram
    participant UI as Frontend Component
    participant Comp as Composable
    participant API as Server API
    participant Svc as Domain Service
    participant Store as Data Store
    participant DB as Database

    UI->>Comp: User Action
    Comp->>API: HTTP Request
    API->>Svc: Business Logic
    Svc->>Store: Data Operation
    Store->>DB: Query/Update
    DB-->>Store: Result
    Store-->>Svc: Data
    Svc-->>API: Response
    API-->>Comp: JSON
    Comp-->>UI: Reactive Update
```

## Abhängigkeits-Diagramm

```mermaid
graph TD
    subgraph Frontend
        UI[UI Components]
        Comp[Composables]
        Utils[Utils]
        Types[Types]
    end

    subgraph Server
        API[API Routes]
        SvcS[Server Services]
        Shared[Shared Utils]
    end

    subgraph Backend
        Domains[Domain Services]
        Infra[Infrastructure]
        CLI[CLI Commands]
    end

    UI --> Comp
    Comp --> Utils
    Comp --> Types
    Comp --> API

    API --> SvcS
    API --> Shared
    SvcS --> Domains

    Domains --> Infra
    CLI --> Domains

    style Frontend fill:#e1f5fe
    style Server fill:#f3e5f5
    style Backend fill:#e8f5e8
```

## Migration-Phasen

```mermaid
gantt
    title Code-Reorganisation Timeline
    dateFormat  YYYY-MM-DD
    section Phase 1: Frontend
    Komponenten kategorisieren    :active, p1a, 2026-05-12, 3d
    Composables strukturieren     :p1b, after p1a, 2d
    Types organisieren           :p1c, after p1b, 2d

    section Phase 2: Server
    API-Routen gruppieren        :p2a, after p1c, 3d
    Services extrahieren         :p2b, after p2a, 2d
    Shared-Module konsolidieren  :p2c, after p2b, 2d

    section Phase 3: Infrastructure
    Verzeichnisstruktur          :p3a, after p2c, 1d
    Path-Mapping konfigurieren   :p3b, after p3a, 1d
    Barrel-Exports erstellen     :p3c, after p3b, 2d

    section Phase 4: Backend
    Auth-Domäne extrahieren      :p4a, after p3c, 3d
    Project-Domäne reorganisieren :p4b, after p4a, 3d
    Agent-Domäne strukturieren   :p4c, after p4b, 3d

    section Phase 5: Orchestrator
    Workflow-Services extrahieren :p5a, after p4c, 4d
    Command-Handler isolieren     :p5b, after p5a, 3d
    Event-System implementieren   :p5c, after p5b, 3d

    section Phase 6: Testing
    Unit-Tests anpassen          :p6a, after p5c, 3d
    Integration-Tests            :p6b, after p6a, 2d
    Dokumentation               :p6c, after p6b, 2d
```

## Risiko-Matrix

```mermaid
quadrantChart
    title Refactoring Risiko-Matrix
    x-axis Low Impact --> High Impact
    y-axis Low Risk --> High Risk

    quadrant-1 Monitor
    quadrant-2 Manage Closely
    quadrant-3 Low Priority
    quadrant-4 Quick Wins

    Utils Migration: [0.2, 0.1]
    Component Reorganization: [0.6, 0.2]
    Composables Structure: [0.5, 0.3]
    Server API Restructure: [0.7, 0.4]
    Domain Extraction: [0.8, 0.6]
    Orchestrator Split: [0.9, 0.8]
    Database Schema Changes: [0.4, 0.9]
```

## Komponenten-Abhängigkeiten

```mermaid
graph LR
    subgraph Custom UI
        DataTable[DataTable.vue]
        FormField[FormField.vue]
        StatusBadge[StatusBadge.vue]
    end

    subgraph Shadcn Base
        Table[Table]
        Input[Input]
        Badge[Badge]
        Button[Button]
    end

    subgraph Domain Components
        ProjectCard[ProjectCard.vue]
        AgentProfile[AgentProfile.vue]
        UserSettings[UserSettings.vue]
    end

    DataTable --> Table
    FormField --> Input
    StatusBadge --> Badge

    ProjectCard --> DataTable
    ProjectCard --> StatusBadge
    AgentProfile --> FormField
    UserSettings --> Button

    style Custom UI fill:#bbdefb
    style Shadcn Base fill:#c8e6c9
    style Domain Components fill:#ffcdd2
```
