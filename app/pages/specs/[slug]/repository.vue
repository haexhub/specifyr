<script setup lang="ts">
import {
  GitBranch,
  Trash2,
  Save,
  TestTube,
  ArrowUp,
  ArrowDown,
  Loader2,
} from "lucide-vue-next";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "~/components/shadcn/card";
import { Button } from "~/components/shadcn/button";
import { Input } from "~/components/shadcn/input";
import { Badge } from "~/components/shadcn/badge";
import ProjectShell from "~/components/projects/ProjectShell.vue";

interface RepositoryStatus {
  configured: boolean;
  url?: string;
  branch?: string;
  username?: string;
  hasToken?: boolean;
}

const route = useRoute();
const slug = computed(() => route.params.slug as string);

const { data, refresh } = await useFetch<RepositoryStatus>(
  () => `/api/projects/${slug.value}/repository`,
);

const url = ref("");
const branch = ref("main");
const username = ref("");
const token = ref("");

const saving = ref(false);
const removing = ref(false);
const pushing = ref(false);
const pulling = ref(false);
const testing = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const testRefs = ref<string[] | null>(null);

watchEffect(() => {
  if (data.value?.configured) {
    url.value = data.value.url ?? "";
    branch.value = data.value.branch ?? "main";
    username.value = data.value.username ?? "";
  }
});

async function save() {
  error.value = null;
  notice.value = null;
  if (
    !url.value.trim() ||
    !username.value.trim() ||
    (!token.value && !data.value?.hasToken)
  ) {
    error.value = "URL, username, and token are required.";
    return;
  }
  saving.value = true;
  try {
    await $fetch(`/api/projects/${slug.value}/repository`, {
      method: "PUT",
      body: {
        url: url.value.trim(),
        branch: branch.value.trim() || "main",
        username: username.value.trim(),
        ...(token.value ? { token: token.value } : {}),
      },
    });
    token.value = "";
    notice.value = "Repository configuration saved.";
    await refresh();
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? "Failed to save.";
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!confirm("Disconnect the remote and delete the stored token?")) return;
  error.value = null;
  notice.value = null;
  removing.value = true;
  try {
    await $fetch(`/api/projects/${slug.value}/repository`, {
      method: "DELETE",
    });
    url.value = "";
    branch.value = "main";
    username.value = "";
    token.value = "";
    testRefs.value = null;
    await refresh();
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? "Failed to disconnect.";
  } finally {
    removing.value = false;
  }
}

async function testConnection() {
  error.value = null;
  notice.value = null;
  testRefs.value = null;
  if (!url.value.trim() || !username.value.trim() || !token.value) {
    error.value = "Fill URL, username, and token before testing.";
    return;
  }
  testing.value = true;
  try {
    const r = await $fetch<{ ok: boolean; refs?: string[]; message?: string }>(
      `/api/projects/${slug.value}/repository/test`,
      {
        method: "POST",
        body: {
          url: url.value.trim(),
          username: username.value.trim(),
          token: token.value,
        },
      },
    );
    if (r.ok) {
      testRefs.value = r.refs ?? [];
      notice.value = `Connection OK — ${r.refs?.length ?? 0} ref(s) discovered.`;
    } else {
      error.value = r.message ?? "Connection failed.";
    }
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? "Connection failed.";
  } finally {
    testing.value = false;
  }
}

async function pushNow() {
  error.value = null;
  notice.value = null;
  pushing.value = true;
  try {
    const r = await $fetch<{ ok: boolean; pushed: boolean }>(
      `/api/projects/${slug.value}/repository/push`,
      {
        method: "POST",
        body: { message: "specifyr: manual push" },
      },
    );
    notice.value = r.pushed ? "Pushed to remote." : "Nothing to push.";
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? "Push failed.";
  } finally {
    pushing.value = false;
  }
}

async function pullNow() {
  error.value = null;
  notice.value = null;
  pulling.value = true;
  try {
    const r = await $fetch<{ ok: boolean; updated: boolean }>(
      `/api/projects/${slug.value}/repository/pull`,
      { method: "POST" },
    );
    notice.value = r.updated
      ? "Pulled changes from remote."
      : "Already up to date.";
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? "Pull failed.";
  } finally {
    pulling.value = false;
  }
}
</script>

<template>
  <ProjectsProjectShell :slug="slug">
    <div class="max-w-2xl space-y-6">
      <div>
        <h2 class="flex items-center gap-2 text-lg font-semibold">
          <GitBranch class="size-4" />
          Repository
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Link this project to an HTTPS git remote (GitHub, GitLab, Bitbucket,
          Gitea, self-hosted). Workflow progress under
          <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs"
            >.specify/</code
          >
          is auto-committed and pushed after each step completion.
        </p>
      </div>

      <p v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {{ error }}
      </p>
      <p v-if="notice" class="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
        {{ notice }}
      </p>

      <Card>
        <CardHeader class="pb-3">
          <CardTitle class="text-sm font-medium">
            {{ data?.configured ? "Connected" : "Connect a remote" }}
          </CardTitle>
          <CardDescription v-if="data?.configured && data.hasToken">
            Token stored. Update fields below and click Save to replace.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="space-y-1">
            <label class="text-xs font-medium text-muted-foreground">HTTPS URL</label>
            <Input
              v-model="url"
              placeholder="https://github.com/acme/demo.git"
              class="font-mono text-sm"
            />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1">
              <label class="text-xs font-medium text-muted-foreground">Branch</label>
              <Input v-model="branch" placeholder="main" />
            </div>
            <div class="space-y-1">
              <label class="text-xs font-medium text-muted-foreground">Username</label>
              <Input v-model="username" placeholder="acme-bot" />
            </div>
          </div>
          <div class="space-y-1">
            <label class="text-xs font-medium text-muted-foreground">
              Personal access token
              <span v-if="data?.hasToken" class="ml-1 text-emerald-600 dark:text-emerald-400">(stored — leave blank to keep)</span>
            </label>
            <Input
              v-model="token"
              type="password"
              placeholder="ghp_… / glpat-… / bbpat-…"
              autocomplete="off"
            />
          </div>

          <div v-if="testRefs && testRefs.length > 0" class="rounded-md border bg-muted/40 px-3 py-2">
            <p class="text-xs font-medium">First refs seen on remote:</p>
            <ul class="mt-1 space-y-0.5">
              <li
                v-for="ref in testRefs"
                :key="ref"
                class="font-mono text-xs text-muted-foreground"
              >
                {{ ref }}
              </li>
            </ul>
          </div>

          <div class="flex flex-wrap gap-2 pt-1">
            <Button :disabled="testing" variant="secondary" @click="testConnection">
              <Loader2 v-if="testing" class="size-4 animate-spin" />
              <TestTube v-else class="size-4" />
              Test connection
            </Button>
            <Button :disabled="saving" @click="save">
              <Loader2 v-if="saving" class="size-4 animate-spin" />
              <Save v-else class="size-4" />
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card v-if="data?.configured">
        <CardHeader class="pb-3">
          <CardTitle class="text-sm font-medium">Sync</CardTitle>
          <CardDescription>
            Manual triggers. Auto-push runs after every step completion.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <Button :disabled="pushing" @click="pushNow">
              <Loader2 v-if="pushing" class="size-4 animate-spin" />
              <ArrowUp v-else class="size-4" />
              Push now
            </Button>
            <Button :disabled="pulling" variant="secondary" @click="pullNow">
              <Loader2 v-if="pulling" class="size-4 animate-spin" />
              <ArrowDown v-else class="size-4" />
              Pull now
            </Button>
            <Button
              :disabled="removing"
              variant="ghost"
              class="ml-auto text-destructive hover:text-destructive"
              @click="remove"
            >
              <Loader2 v-if="removing" class="size-4 animate-spin" />
              <Trash2 v-else class="size-4" />
              Disconnect
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  </ProjectsProjectShell>
</template>
