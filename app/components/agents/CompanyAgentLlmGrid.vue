<script setup lang="ts">
import type {
  CompanyAgentProfile,
  AgentMeta,
} from "~/components/agents/CompanyAgentProfileCard.vue";
import type { CredentialRow } from "~/components/settings/LlmCredentialCard.vue";

interface PerRoleEntry {
  role: string;
  agent: AgentMeta;
  userProfile: CompanyAgentProfile | null;
  orgProfile: CompanyAgentProfile | null;
  effective: { scope: "user" | "org"; profile: CompanyAgentProfile } | null;
}

interface Aggregate {
  slug: string;
  ownerOrgId: string | null;
  ownerOrgSlug: string | null;
  roles: string[];
  perRole: PerRoleEntry[];
}

interface OrgCredsResponse {
  org: { id: string; slug: string; name: string };
  myRole: "admin" | "member";
  credentials: CredentialRow[];
}

const props = defineProps<{ orgSlug: string; projSlug: string }>();

const apiBase = computed(() => `/api/orgs/${props.orgSlug}/projects/${props.projSlug}`);

const { data: aggregate, refresh: refreshAggregate } = await useFetch<Aggregate>(
  () => `${apiBase.value}/company/agent-profiles`,
  { default: () => ({ slug: props.projSlug, ownerOrgId: null, ownerOrgSlug: null, roles: [], perRole: [] }) },
);

const { data: userCredentials, refresh: refreshUserCreds } = await useFetch<CredentialRow[]>(
  "/api/me/llm-credentials",
  { default: () => [] },
);

const ownerOrgSlug = computed(() => aggregate.value?.ownerOrgSlug ?? null);

const { data: orgCredsData, refresh: refreshOrgCreds } = await useFetch<OrgCredsResponse | null>(
  () => (ownerOrgSlug.value ? `/api/orgs/${ownerOrgSlug.value}/llm-credentials` : ""),
  {
    default: () => null,
    immediate: false,
  },
);

watch(
  ownerOrgSlug,
  (slug) => {
    if (slug) refreshOrgCreds();
  },
  { immediate: true },
);

const orgCredentials = computed<CredentialRow[]>(
  () => orgCredsData.value?.credentials ?? [],
);
const canEditOrg = computed(() => orgCredsData.value?.myRole === "admin");

async function refreshAll() {
  const tasks: Promise<unknown>[] = [refreshAggregate(), refreshUserCreds()];
  if (ownerOrgSlug.value) tasks.push(refreshOrgCreds());
  await Promise.all(tasks);
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="!aggregate || aggregate.roles.length === 0" class="text-sm text-muted-foreground">
      No agent specs found in this project. Once <code>.specify/org/agents/</code> contains role
      definitions (run the company workflow's hire step), each role appears here with its own LLM
      configuration.
    </div>

    <AgentsCompanyAgentProfileCard
      v-for="entry in aggregate?.perRole ?? []"
      :key="entry.role"
      :agent="entry.agent"
      :user-profile="entry.userProfile"
      :org-profile="entry.orgProfile"
      :effective-scope="entry.effective?.scope ?? null"
      :user-credentials="userCredentials ?? []"
      :org-credentials="orgCredentials"
      :user-endpoint="`/api/me/agent-profiles/company-agents/${entry.role}`"
      :org-endpoint="ownerOrgSlug ? `/api/orgs/${ownerOrgSlug}/agent-profiles/company-agents/${entry.role}` : null"
      user-credentials-endpoint="/api/me/llm-credentials"
      :org-credentials-endpoint="ownerOrgSlug ? `/api/orgs/${ownerOrgSlug}/llm-credentials` : null"
      :can-edit-org="canEditOrg"
      @changed="refreshAll()"
    />
  </div>
</template>
