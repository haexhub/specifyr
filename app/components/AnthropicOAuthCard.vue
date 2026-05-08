<script lang="ts">
export interface AnthropicOauthCredential {
  id: string;
  oauthStatus: "pending" | "authorized" | "expired" | null;
}
</script>

<script setup lang="ts">
import { ExternalLink, LogIn, LogOut, X } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

const props = defineProps<{
  /**
   * Authorized credential row, if any. When set, the card renders
   * the "Connected" state with a sign-out button.
   */
  existing: AnthropicOauthCredential | null;
  /**
   * API base path. Personal: /api/me/llm-credentials/oauth/anthropic.
   * Org: /api/orgs/<slug>/llm-credentials/oauth/anthropic.
   * Also used for the DELETE endpoint by appending the credential id
   * to the parent path (one level up).
   */
  endpoint: string;
  /**
   * Path used for DELETE on an existing authorized credential.
   * Personal: /api/me/llm-credentials/<id>.
   * Org: /api/orgs/<slug>/llm-credentials/<id>.
   * Kept distinct from `endpoint` because the DELETE doesn't live
   * under the oauth/anthropic/ path.
   */
  deleteEndpoint: string;
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  changed: [];
}>();

interface FlowState {
  id: string;
  url: string;
}

interface DiskStatus {
  id: string;
  oauthStatus: "pending" | "authorized" | "expired" | null;
  expiresAt: string | null;
  fileExists: boolean;
}

type ConnectedState = "fresh" | "expired" | "missing";

const flow = ref<FlowState | null>(null);
const code = ref("");
const starting = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);
const expiresAt = ref<string | null>(null);

// Lazy disk-state fetch. URL is reactive on `existing.id`; when there
// is no existing credential, the URL evaluates to null and useFetch
// stays idle (no request fired, no SSR payload reserved).
const { data: diskStatus } = useFetch<DiskStatus>(
  () =>
    props.existing
      ? `${props.endpoint}/${props.existing.id}/status`
      : null,
  {
    default: () => null,
    watch: [() => props.existing?.id],
    onResponseError(ctx) {
      // Don't blow up the page on a transient 4xx/5xx — the card
      // falls back to the row's `oauthStatus` until the next refresh.
      ctx.response._data = null;
    },
  },
);

const connectedState = computed<ConnectedState | null>(() => {
  if (!props.existing) return null;
  // 'pending' = a flow is mid-air (modal open) or was abandoned. Treat
  // as "no credentials yet" so the under-modal view shows the plain
  // login button instead of a misleading "re-auth required".
  if (props.existing.oauthStatus === "pending") return null;
  const ds = diskStatus.value;
  // No disk-state yet (first paint): trust the row's status — if it's
  // 'authorized' show fresh, otherwise treat as missing. The fetch
  // will refine this on next tick.
  if (!ds) {
    return props.existing.oauthStatus === "authorized" ? "fresh" : "missing";
  }
  if (!ds.fileExists) return "missing";
  if (ds.expiresAt && new Date(ds.expiresAt).getTime() <= Date.now()) {
    return "expired";
  }
  return "fresh";
});

async function start() {
  starting.value = true;
  error.value = null;
  try {
    const r = await $fetch<{ id: string; url: string }>(`${props.endpoint}/start`, {
      method: "POST",
    });
    flow.value = { id: r.id, url: r.url };
    code.value = "";
  } catch (err: unknown) {
    error.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "could not start sign-in");
  } finally {
    starting.value = false;
  }
}

async function submitCode() {
  if (!flow.value || !code.value.trim()) return;
  submitting.value = true;
  error.value = null;
  try {
    const r = await $fetch<{ expiresAt: string }>(
      `${props.endpoint}/${flow.value.id}/code`,
      { method: "POST", body: { code: code.value.trim() } },
    );
    expiresAt.value = r.expiresAt;
    flow.value = null;
    code.value = "";
    emit("changed");
  } catch (err: unknown) {
    error.value =
      (err as { statusMessage?: string })?.statusMessage ??
      (err instanceof Error ? err.message : "code submission failed");
  } finally {
    submitting.value = false;
  }
}

async function cancel() {
  if (!flow.value) return;
  const id = flow.value.id;
  flow.value = null;
  code.value = "";
  error.value = null;
  await $fetch(`${props.endpoint}/${id}/cancel`, { method: "POST" }).catch(
    () => undefined,
  );
  emit("changed");
}

async function signOut() {
  if (!props.existing) return;
  if (
    !confirm(
      "Sign out of Claude? Agent runs that fall back to this credential will fail until you sign in again.",
    )
  ) {
    return;
  }
  await $fetch(`${props.deleteEndpoint}/${props.existing.id}`, {
    method: "DELETE",
  });
  emit("changed");
}
</script>

<template>
  <section class="mt-8 rounded-lg border border-primary/30 bg-primary/5">
    <header
      class="flex items-center justify-between gap-3 border-b border-primary/20 px-4 py-3"
    >
      <div>
        <h2 class="font-medium">Sign in with Claude (OAuth)</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Use your Claude Pro/Max subscription instead of an API key. Tokens
          are stored on disk, never seen by agents — agents get a short-lived
          session token routed through the proxy.
        </p>
      </div>
    </header>

    <div class="px-4 py-3">
      <template v-if="connectedState === 'fresh'">
        <p class="text-sm">
          <span class="font-medium text-primary">✓ Connected.</span>
          Agents resolved to your user will route through the multi-tenant
          claude-proxy.
        </p>
        <Button
          v-if="!readOnly"
          class="mt-3"
          size="sm"
          variant="outline"
          @click="signOut"
        >
          <LogOut class="size-4" /> Sign out
        </Button>
      </template>
      <template v-else-if="connectedState === 'expired'">
        <p class="text-sm">
          <span class="font-medium text-amber-600">⟳ Token expired.</span>
          Will be refreshed automatically on the next agent run.
        </p>
        <Button
          v-if="!readOnly"
          class="mt-3"
          size="sm"
          variant="outline"
          @click="signOut"
        >
          <LogOut class="size-4" /> Sign out
        </Button>
      </template>
      <template v-else-if="connectedState === 'missing'">
        <p class="text-sm">
          <span class="font-medium text-destructive">⚠ Re-authentication required.</span>
          The credentials file is no longer present on disk.
        </p>
        <div v-if="!readOnly" class="mt-3 flex gap-2">
          <Button size="sm" :disabled="starting" @click="start">
            <LogIn class="size-4" />
            {{ starting ? "Starting…" : "Login again" }}
          </Button>
          <Button size="sm" variant="outline" @click="signOut">
            <LogOut class="size-4" /> Sign out
          </Button>
        </div>
      </template>
      <template v-else>
        <Button
          v-if="!readOnly"
          size="sm"
          :disabled="starting"
          @click="start"
        >
          <LogIn class="size-4" />
          {{ starting ? "Starting…" : "Login with Claude" }}
        </Button>
        <p v-if="readOnly" class="text-xs text-muted-foreground">
          Only org admins can configure OAuth at the org level.
        </p>
      </template>
      <p v-if="error && !flow" class="mt-2 text-sm text-destructive">
        {{ error }}
      </p>
    </div>

    <Teleport to="body">
      <div
        v-if="flow"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
        @click.self="cancel"
      >
        <div
          class="relative w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl"
        >
          <button
            type="button"
            class="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            @click="cancel"
          >
            <X class="size-4" />
          </button>

          <h3 class="text-lg font-semibold">Authorize Claude</h3>
          <ol class="mt-4 space-y-3 text-sm">
            <li>
              <span class="font-medium">1.</span> Open this URL in a new tab
              and authorize:
              <a
                :href="flow.url"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-1 flex items-center gap-1 break-all rounded-md bg-muted px-2 py-1.5 text-xs hover:bg-accent"
              >
                <ExternalLink class="size-3.5 shrink-0" />
                <span class="truncate">{{ flow.url }}</span>
              </a>
            </li>
            <li>
              <span class="font-medium">2.</span> Anthropic will display a
              code. Paste it here:
              <Input
                v-model="code"
                class="mt-1 font-mono text-xs"
                placeholder="paste the code"
                :disabled="submitting"
                @keydown.enter.prevent="submitCode"
              />
            </li>
          </ol>
          <p v-if="error" class="mt-3 text-sm text-destructive">
            {{ error }}
          </p>
          <div class="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              :disabled="submitting"
              @click="cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              :disabled="submitting || !code.trim()"
              @click="submitCode"
            >
              {{ submitting ? "Submitting…" : "Submit code" }}
            </Button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
