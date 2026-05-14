<script setup lang="ts">
import {
  Activity,
  Bot,
  Building2,
  FolderKanban,
  RefreshCw,
  Settings,
  Users,
} from "lucide-vue-next";

interface RunningCompany {
  slug: string;
  ceoRole: string;
  agentCount: number;
  orgSlug: string | null;
  orgName: string | null;
}

interface ProviderBucket {
  total: number;
  oauth: number;
  apiKey: number;
}

interface OverviewResponse {
  users: { total: number; newLast7d: number };
  orgs: { total: number; avgMembers: number };
  projects: { total: number };
  sessions: { active: number };
  runningCompanies: RunningCompany[];
  credentialsByProvider: {
    anthropic: ProviderBucket;
    openai: ProviderBucket;
    google: ProviderBucket;
    openrouter: ProviderBucket;
  };
  generatedAt: string;
}

const emptyBucket: ProviderBucket = { total: 0, oauth: 0, apiKey: 0 };
const emptyOverview: OverviewResponse = {
  users: { total: 0, newLast7d: 0 },
  orgs: { total: 0, avgMembers: 0 },
  projects: { total: 0 },
  sessions: { active: 0 },
  runningCompanies: [],
  credentialsByProvider: {
    anthropic: { ...emptyBucket },
    openai: { ...emptyBucket },
    google: { ...emptyBucket },
    openrouter: { ...emptyBucket },
  },
  generatedAt: new Date().toISOString(),
};

const { data, pending, refresh } = await useFetch<OverviewResponse>(
  "/api/admin/overview",
  { default: () => emptyOverview },
);

const refreshing = ref(false);
async function manualRefresh() {
  refreshing.value = true;
  try {
    await refresh();
  } finally {
    refreshing.value = false;
  }
}

const generatedAtLabel = computed(() => {
  const v = data.value?.generatedAt;
  if (!v) return "—";
  return new Date(v).toLocaleTimeString();
});

const providers = computed(() => {
  const c = data.value.credentialsByProvider;
  return [
    { key: "anthropic", label: "Anthropic", bucket: c.anthropic },
    { key: "openai", label: "OpenAI", bucket: c.openai },
    { key: "google", label: "Google", bucket: c.google },
    { key: "openrouter", label: "OpenRouter", bucket: c.openrouter },
  ];
});
</script>

<template>
  <div>
    <div class="flex items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Platform overview</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Tenant counts and current load across the specifyr deployment.
        </p>
      </div>
      <div class="flex items-center gap-3 text-xs text-muted-foreground">
        <span>Last refreshed: {{ generatedAtLabel }}</span>
        <Button
          variant="outline"
          size="sm"
          :disabled="pending || refreshing"
          @click="manualRefresh"
        >
          <RefreshCw class="mr-1.5 size-3.5" :class="{ 'animate-spin': refreshing }" />
          Refresh
        </Button>
      </div>
    </div>

    <div v-if="pending && !data.users.total" class="mt-6 text-sm text-muted-foreground">
      Loading…
    </div>

    <div v-else class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div class="rounded-lg border border-border bg-muted/30 p-4">
        <div class="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <Users class="size-3.5" /> Users
        </div>
        <div class="mt-2 text-3xl font-semibold">{{ data.users.total }}</div>
        <div class="mt-1 text-xs text-muted-foreground">
          +{{ data.users.newLast7d }} in last 7 days
        </div>
      </div>

      <div class="rounded-lg border border-border bg-muted/30 p-4">
        <div class="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <Building2 class="size-3.5" /> Organizations
        </div>
        <div class="mt-2 text-3xl font-semibold">{{ data.orgs.total }}</div>
        <div class="mt-1 text-xs text-muted-foreground">
          {{ data.orgs.avgMembers }} avg members/org
        </div>
      </div>

      <div class="rounded-lg border border-border bg-muted/30 p-4">
        <div class="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <FolderKanban class="size-3.5" /> Projects
        </div>
        <div class="mt-2 text-3xl font-semibold">{{ data.projects.total }}</div>
        <div class="mt-1 text-xs text-muted-foreground">org-owned</div>
      </div>

      <div class="rounded-lg border border-border bg-muted/30 p-4">
        <div class="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <Activity class="size-3.5" /> Active sessions
        </div>
        <div class="mt-2 text-3xl font-semibold">{{ data.sessions.active }}</div>
        <div class="mt-1 text-xs text-muted-foreground">
          runner tokens currently valid
        </div>
      </div>
    </div>

    <div class="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section class="rounded-lg border border-border bg-muted/30 p-4">
        <div class="flex items-center gap-2 text-sm font-medium">
          <Bot class="size-4" /> Running companies
          <span class="ml-auto text-xs text-muted-foreground">
            {{ data.runningCompanies.length }} active
          </span>
        </div>
        <div v-if="!data.runningCompanies.length" class="mt-4 text-sm text-muted-foreground">
          No companies are running right now.
        </div>
        <ul v-else class="mt-4 space-y-2">
          <li
            v-for="c in data.runningCompanies"
            :key="c.slug"
            class="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2"
          >
            <div>
              <div class="font-mono text-sm">{{ c.slug }}</div>
              <div class="text-xs text-muted-foreground">
                <template v-if="c.orgSlug">
                  org <span class="font-mono">/{{ c.orgSlug }}</span>
                  <span v-if="c.orgName"> · {{ c.orgName }}</span>
                </template>
                <template v-else>unknown org</template>
              </div>
            </div>
            <div class="text-right text-xs text-muted-foreground">
              <div>{{ c.agentCount }} agents</div>
              <div class="font-mono">CEO: {{ c.ceoRole }}</div>
            </div>
          </li>
        </ul>
      </section>

      <section class="rounded-lg border border-border bg-muted/30 p-4">
        <div class="flex items-center gap-2 text-sm font-medium">
          <Settings class="size-4" /> LLM credentials by provider
        </div>
        <Table class="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead class="text-right">Total</TableHead>
              <TableHead class="text-right">OAuth</TableHead>
              <TableHead class="text-right">API key</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="p in providers" :key="p.key">
              <TableCell>{{ p.label }}</TableCell>
              <TableCell class="text-right font-mono">
                {{ p.bucket.total }}
              </TableCell>
              <TableCell class="text-right font-mono text-muted-foreground">
                {{ p.bucket.oauth }}
              </TableCell>
              <TableCell class="text-right font-mono text-muted-foreground">
                {{ p.bucket.apiKey }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>
    </div>
  </div>
</template>
