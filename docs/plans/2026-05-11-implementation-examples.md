# Implementierungs-Beispiele für Code-Reorganisation

## 1. Frontend-Komponenten Reorganisation

### Aktuelle Struktur → Neue Struktur

**Vorher:**

```
app/components/
├── AgentDetailDrawer.vue
├── ProjectCard.vue
├── shadcn/button/Button.vue
├── shadcn/card/Card.vue
└── ...
```

**Nachher:**

```
app/components/
├── ui/
│   ├── DataTable.vue          # Custom auf shadcn Table basierend
│   ├── ProjectCard.vue        # Business-spezifische Komponente
│   └── AgentDetailDrawer.vue  # Custom Drawer
├── shadcn/
│   ├── button/Button.vue      # Reine shadcn Komponente
│   ├── card/Card.vue          # Reine shadcn Komponente
│   └── table/Table.vue        # Reine shadcn Komponente
├── auth/
│   ├── LoginForm.vue
│   └── UserProfile.vue
├── projects/
│   ├── ProjectList.vue
│   └── ProjectSettings.vue
└── layout/
    ├── AppHeader.vue
    └── Sidebar.vue
```

### Beispiel: Custom UI Komponente

```vue
<!-- app/components/ui/DataTable.vue -->
<template>
  <div class="space-y-4">
    <!-- Search und Filter -->
    <div class="flex items-center justify-between">
      <Input v-model="searchTerm" placeholder="Suchen..." class="max-w-sm" />
      <Button @click="refresh"> Aktualisieren </Button>
    </div>

    <!-- Tabelle -->
    <div class="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead
              v-for="column in columns"
              :key="column.key"
              @click="sort(column.key)"
              class="cursor-pointer"
            >
              {{ column.label }}
              <ChevronUpIcon
                v-if="sortBy === column.key && sortOrder === 'asc'"
              />
              <ChevronDownIcon
                v-if="sortBy === column.key && sortOrder === 'desc'"
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="item in filteredData" :key="item.id">
            <TableCell v-for="column in columns" :key="column.key">
              <slot :name="column.key" :item="item">
                {{ item[column.key] }}
              </slot>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </div>
</template>

<script setup lang="ts">
// Importiert reine shadcn Komponenten
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "~/components/shadcn/table";
import { Input } from "~/components/shadcn/input";
import { Button } from "~/components/shadcn/button";

interface Column {
  key: string;
  label: string;
  sortable?: boolean;
}

interface Props {
  data: any[];
  columns: Column[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  refresh: [];
}>();

// Custom Logic für erweiterte Funktionalität
const searchTerm = ref("");
const sortBy = ref("");
const sortOrder = ref<"asc" | "desc">("asc");

const filteredData = computed(() => {
  let result = props.data;

  // Suche
  if (searchTerm.value) {
    result = result.filter((item) =>
      Object.values(item).some((value) =>
        String(value).toLowerCase().includes(searchTerm.value.toLowerCase()),
      ),
    );
  }

  // Sortierung
  if (sortBy.value) {
    result = [...result].sort((a, b) => {
      const aVal = a[sortBy.value];
      const bVal = b[sortBy.value];
      const modifier = sortOrder.value === "asc" ? 1 : -1;
      return aVal > bVal ? modifier : -modifier;
    });
  }

  return result;
});

const sort = (key: string) => {
  if (sortBy.value === key) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortBy.value = key;
    sortOrder.value = "asc";
  }
};

const refresh = () => {
  emit("refresh");
};
</script>
```

## 2. Composables Reorganisation

### Neue Composables Struktur

```
app/composables/
├── auth/
│   ├── useAuth.ts
│   ├── useLogin.ts
│   └── usePermissions.ts
├── projects/
│   ├── useProjects.ts
│   ├── useProjectDetail.ts
│   └── useProjectSettings.ts
├── agents/
│   ├── useAgents.ts
│   ├── useAgentProfiles.ts
│   └── useAgentRuns.ts
└── core/
    ├── useApi.ts
    ├── useNotifications.ts
    └── useWebSocket.ts
```

### Beispiel: Auth Composable

```typescript
// app/composables/auth/useAuth.ts
import type { User, LoginCredentials } from "~/types/auth";

export const useAuth = () => {
  const user = ref<User | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const login = async (credentials: LoginCredentials) => {
    isLoading.value = true;
    error.value = null;

    try {
      const { data } = await $fetch<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: credentials,
      });

      user.value = data.user;
      await navigateTo("/dashboard");
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Login fehlgeschlagen";
    } finally {
      isLoading.value = false;
    }
  };

  const logout = async () => {
    try {
      await $fetch("/api/auth/logout", { method: "POST" });
      user.value = null;
      await navigateTo("/login");
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  const fetchUser = async () => {
    try {
      const { data } = await $fetch<{ user: User }>("/api/me");
      user.value = data.user;
    } catch (err) {
      user.value = null;
    }
  };

  // Auto-fetch user on mount
  onMounted(() => {
    fetchUser();
  });

  return {
    user: readonly(user),
    isLoading: readonly(isLoading),
    error: readonly(error),
    login,
    logout,
    fetchUser,
  };
};
```

## 3. Server Reorganisation (Flache Struktur)

### Neue Server Struktur

```
server/
├── auth/
│   ├── api/
│   │   ├── login.post.ts
│   │   ├── logout.post.ts
│   │   └── me.get.ts
│   ├── services/
│   │   ├── auth-service.ts
│   │   └── user-service.ts
│   └── middleware/
│       └── auth-guard.ts
├── projects/
│   ├── api/
│   │   ├── index.get.ts
│   │   ├── [slug].get.ts
│   │   └── [slug].delete.ts
│   └── services/
│       └── project-service.ts
└── shared/
    ├── database/
    │   ├── client.ts
    │   └── schema.ts
    ├── validation/
    │   └── schemas.ts
    └── utils/
        └── response.ts
```

### Beispiel: Auth Service

```typescript
// server/auth/services/auth-service.ts
import { eq } from "drizzle-orm";
import { getDb } from "~/server/shared/database/client";
import { users } from "~/server/shared/database/schema";
import type { LoginCredentials, User } from "~/types/auth";

export class AuthService {
  private db = getDb();

  async login(credentials: LoginCredentials): Promise<User> {
    const user = await this.db
      .select()
      .from(users)
      .where(eq(users.email, credentials.email))
      .limit(1);

    if (!user.length) {
      throw new Error("Benutzer nicht gefunden");
    }

    // Password verification logic here
    const isValidPassword = await this.verifyPassword(
      credentials.password,
      user[0].passwordHash,
    );

    if (!isValidPassword) {
      throw new Error("Ungültiges Passwort");
    }

    return {
      id: user[0].id,
      email: user[0].email,
      displayName: user[0].displayName,
      createdAt: user[0].createdAt,
    };
  }

  async getUserById(id: string): Promise<User | null> {
    const user = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!user.length) {
      return null;
    }

    return {
      id: user[0].id,
      email: user[0].email,
      displayName: user[0].displayName,
      createdAt: user[0].createdAt,
    };
  }

  private async verifyPassword(
    password: string,
    hash: string,
  ): Promise<boolean> {
    // Password verification implementation
    return true; // Placeholder
  }
}
```

### Beispiel: API Route

```typescript
// server/auth/api/login.post.ts
import { AuthService } from "../services/auth-service";
import { loginSchema } from "~/server/shared/validation/schemas";

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event);

    // Validierung
    const credentials = loginSchema.parse(body);

    // Service aufrufen
    const authService = new AuthService();
    const user = await authService.login(credentials);

    // Session setzen (vereinfacht)
    await setUserSession(event, { userId: user.id });

    return {
      success: true,
      data: { user },
    };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage:
        error instanceof Error ? error.message : "Login fehlgeschlagen",
    });
  }
});
```

## 4. Types Reorganisation

### Neue Types Struktur

```typescript
// app/types/auth.ts
export interface User {
  id: string;
  email: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  createdAt: string;
  memberships: MeMembership[];
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface MeMembership {
  orgId: string;
  orgSlug: string;
  orgName: string;
  role: "admin" | "member";
  isOwner: boolean;
}
```

```typescript
// app/types/projects.ts
export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  orgId: string;
}

export type ProjectStatus = "draft" | "active" | "completed" | "archived";

export interface CreateProjectRequest {
  name: string;
  description?: string;
  orgId: string;
}
```

## 5. Barrel Exports

### Domain Index Files

```typescript
// src/domains/auth/index.ts
export { AuthService } from "./services/auth-service";
export { UserStore } from "./stores/user-store";
export type { User, LoginCredentials } from "./types";
```

```typescript
// src/domains/projects/index.ts
export { ProjectService } from "./services/project-service";
export { ProjectStore } from "./stores/project-store";
export { ProjectWorkflow } from "./workflows/project-workflow";
export type { Project, ProjectStatus } from "./types";
```

### Shared Index Files

```typescript
// src/shared/index.ts
export { DatabaseClient } from "./infrastructure/database/client";
export { EventBus } from "./infrastructure/events/event-bus";
export { FileSystemService } from "./infrastructure/filesystem/service";
export * from "./utils";
export * from "./types";
```

## 6. Path Mapping Konfiguration

```json
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "~/*": ["./app/*"],
      "@/*": ["./src/*"],
      "@shared/*": ["./src/shared/*"],
      "@domains/*": ["./src/domains/*"],
      "@server/*": ["./server/*"]
    }
  }
}
```

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  alias: {
    "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    "@domains": fileURLToPath(new URL("./src/domains", import.meta.url)),
  },
  imports: {
    dirs: ["composables/**", "utils/**", "types/**"],
  },
});
```

## 7. Migration Script Beispiel

```typescript
// scripts/migrate-components.ts
import { promises as fs } from "fs";
import path from "path";

const COMPONENT_MAPPINGS = {
  "AgentDetailDrawer.vue": "ui/AgentDetailDrawer.vue",
  "ProjectCard.vue": "ui/ProjectCard.vue",
  "LoginForm.vue": "auth/LoginForm.vue",
  "UserProfile.vue": "auth/UserProfile.vue",
};

async function migrateComponents() {
  const componentsDir = "./app/components";

  for (const [oldPath, newPath] of Object.entries(COMPONENT_MAPPINGS)) {
    const oldFullPath = path.join(componentsDir, oldPath);
    const newFullPath = path.join(componentsDir, newPath);

    try {
      // Erstelle Zielverzeichnis falls nötig
      await fs.mkdir(path.dirname(newFullPath), { recursive: true });

      // Verschiebe Datei
      await fs.rename(oldFullPath, newFullPath);

      console.log(`✅ Moved ${oldPath} → ${newPath}`);
    } catch (error) {
      console.error(`❌ Failed to move ${oldPath}:`, error);
    }
  }
}

migrateComponents().catch(console.error);
```

## Nächste Schritte

1. **Frontend-Reorganisation starten**: Komponenten nach neuer Struktur verschieben
2. **Composables extrahieren**: Business-Logik aus Komponenten in Composables
3. **Server-Services erstellen**: API-Logik in Services auslagern
4. **Types definieren**: Gemeinsame Type-Definitionen erstellen
5. **Barrel-Exports implementieren**: Saubere Import-Struktur schaffen

Diese Beispiele zeigen konkret, wie die neue Architektur implementiert werden kann, während die bestehende Funktionalität erhalten bleibt.
