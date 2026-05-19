<script setup lang="ts">
import { computed, ref } from "vue";

import DraftSidebar, {
  type DraftSummary,
} from "~/components/speckit/DraftSidebar.vue";
import PublishDialog from "~/components/speckit/PublishDialog.vue";
import SpeckitChatHost from "~/components/speckit/SpeckitChatHost.vue";
import { useProviderIdentityStore } from "~/stores/provider-identity";
import { useActiveSessionStore } from "~/stores/active-session";

const { orgSlug, projSlug, apiBase } = useProjectContext();
const { project } = await useProject();

const identity = useProviderIdentityStore();
const session = useActiveSessionStore();
const router = useRouter();
const route = useRoute();

const activeDraftId = computed(() =>
  typeof route.query.draft === "string" ? route.query.draft : null,
);

const drafts = ref<DraftSummary[]>([]);
const publicVersion = ref(0);
const loadingDrafts = ref(false);

async function refreshDrafts() {
  loadingDrafts.value = true;
  try {
    const [draftsRes, publicRes] = await Promise.all([
      $fetch<{ drafts: DraftSummary[] }>(`${apiBase.value}/spec-drafts/mine`),
      $fetch<{ version: number; files: Array<{ name: string; content: string }> }>(
        `${apiBase.value}/spec-public-state`,
      ),
    ]);
    drafts.value = draftsRes.drafts;
    publicVersion.value = publicRes.version;
  } finally {
    loadingDrafts.value = false;
  }
}

await refreshDrafts();

// Auto-select most-recent draft on first visit. Subsequent draft
// switches are user-initiated via the sidebar.
if (!activeDraftId.value && drafts.value.length) {
  const newest = [...drafts.value].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )[0]!;
  router.replace({ query: { ...route.query, draft: newest.id } });
}

function selectDraft(draftId: string) {
  if (draftId === activeDraftId.value) return;
  router.replace({ query: { ...route.query, draft: draftId } });
}

const creating = ref(false);
async function createNewDraft() {
  if (creating.value) return;
  creating.value = true;
  try {
    const pub = await $fetch<{
      version: number;
      files: Array<{ name: string; content: string }>;
    }>(`${apiBase.value}/spec-public-state`);
    const stamp = new Date().toLocaleString();
    const res = await $fetch<{ draftId: string }>(`${apiBase.value}/spec-drafts`, {
      method: "POST",
      body: {
        title: `Draft ${stamp}`,
        baseVersion: pub.version,
        files: pub.files,
        conversation: [],
      },
    });
    await refreshDrafts();
    router.replace({ query: { ...route.query, draft: res.draftId } });
  } finally {
    creating.value = false;
  }
}

// Host owns the per-draft composable; the `key` on the component
// forces a fresh mount when draftId changes, which is what triggers
// the composable's onMounted -> openDraft.
const chatHostRef = ref<InstanceType<typeof SpeckitChatHost> | null>(null);

// Publish flow + conflict dialog.
const publishDialogOpen = ref(false);
const publishConflict = ref<{
  currentPublicVersion: number;
  currentPublicFiles: Array<{ name: string; content: string }>;
} | null>(null);
const publishing = ref(false);

async function tryPublish() {
  if (!chatHostRef.value || publishing.value) return;
  publishing.value = true;
  try {
    const res = await chatHostRef.value.publish();
    if ("conflict" in res) {
      publishConflict.value = {
        currentPublicVersion: res.currentPublicVersion,
        currentPublicFiles: res.currentPublicFiles,
      };
      publishDialogOpen.value = true;
    } else {
      publishConflict.value = null;
      publishDialogOpen.value = false;
      await refreshDrafts();
    }
  } finally {
    publishing.value = false;
  }
}

function pullPublicIntoDraft() {
  if (!publishConflict.value || !session.session) return;
  const newFiles: Record<string, string> = { ...session.session.files };
  for (const f of publishConflict.value.currentPublicFiles) {
    newFiles[f.name] = f.content;
  }
  session.updateFiles(newFiles);
  publishDialogOpen.value = false;
}
</script>

<template>
  <ProjectsProjectShell
    v-if="project"
    :org-slug="orgSlug"
    :proj-slug="projSlug"
    :project-title="project.title"
  >
    <div class="flex h-[calc(100vh-8rem)] gap-0 overflow-hidden rounded-lg border border-border">
      <aside class="w-64 shrink-0 border-r border-border bg-card">
        <DraftSidebar
          :drafts="drafts"
          :active-draft-id="activeDraftId"
          :public-version="publicVersion"
          :busy="creating || loadingDrafts"
          @select="selectDraft"
          @new-draft="createNewDraft"
        />
      </aside>

      <div class="flex-1 overflow-hidden bg-background">
        <div
          v-if="!identity.active"
          class="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground"
        >
          <div class="max-w-md space-y-2">
            <p class="font-medium text-foreground">No provider identity configured</p>
            <p>
              The browser-side Speckit agent needs an LLM provider with your own API key.
              Configure one under
              <NuxtLink to="/settings/speckit-agent" class="text-primary underline">
                Settings → Speckit agent
              </NuxtLink>.
            </p>
          </div>
        </div>
        <SpeckitChatHost
          v-else-if="activeDraftId"
          :key="activeDraftId"
          ref="chatHostRef"
          :org-slug="orgSlug"
          :proj-slug="projSlug"
          :draft-id="activeDraftId"
          @publish="tryPublish"
        />
        <div
          v-else
          class="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground"
        >
          <div class="max-w-md space-y-2">
            <p>Pick a draft from the sidebar — or click <span class="font-medium text-foreground">New</span> to start from the current public state.</p>
          </div>
        </div>
      </div>
    </div>

    <PublishDialog
      v-if="session.session"
      v-model:open="publishDialogOpen"
      :conflict="publishConflict"
      :draft-files="session.session.files"
      :draft-base-version="session.session.baseVersion"
      @retry="tryPublish"
      @copy-public="pullPublicIntoDraft"
    />
  </ProjectsProjectShell>
</template>
