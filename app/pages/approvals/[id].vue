<script setup lang="ts">
definePageMeta({ layout: "workspace" });

import { Check, X, ArrowUpRight, Loader2, ShieldQuestion, AlertTriangle } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/shadcn/card";
import { Badge } from "~/components/shadcn/badge";

interface ApprovalDetail {
  requestId: string;
  slug: string;
  agent: string;
  capability: string;
}

type Decision = "approved" | "denied" | "escalated";

const { t } = useI18n();
const route = useRoute();
const id = computed(() => route.params.id as string);

const {
  data: approval,
  error: fetchError,
  pending: fetchPending,
} = await useFetch<ApprovalDetail>(() => `/api/approvals/${id.value}`, {
  key: () => `approval-${id.value}`,
});

const submitting = ref(false);
const submitError = ref<string | null>(null);
const decided = ref<Decision | null>(null);

async function decide(decision: Decision) {
  submitError.value = null;
  submitting.value = true;
  try {
    await $fetch(`/api/approvals/${id.value}/decide`, {
      method: "POST",
      body: { decision, by: "ui" },
    });
    decided.value = decision;
  } catch (err: unknown) {
    const e = err as { statusCode?: number; statusMessage?: string; message?: string };
    if (e.statusCode === 404) {
      submitError.value = t("approvals.saveErrorDesc404");
    } else {
      submitError.value = e.statusMessage ?? e.message ?? t("approvals.saveErrorGeneric");
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="flex h-full items-center justify-center p-6">
    <div class="w-full max-w-md">
      <Card v-if="fetchPending && !approval">
        <CardContent class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" /> {{ $t("approvals.loading") }}
        </CardContent>
      </Card>

      <Card v-else-if="fetchError">
        <CardHeader>
          <div class="flex items-center gap-2">
            <AlertTriangle class="size-5 text-amber-500" />
            <CardTitle class="text-base">{{ $t("approvals.notFound") }}</CardTitle>
          </div>
        </CardHeader>
        <CardContent class="space-y-3 text-sm text-muted-foreground">
          <p>{{ $t("approvals.notFoundDesc") }}</p>
          <p class="font-mono text-xs">{{ id }}</p>
          <NuxtLink to="/" class="inline-flex items-center gap-1 text-primary hover:underline">
            <ArrowUpRight class="size-3.5" /> {{ $t("approvals.toOverview") }}
          </NuxtLink>
        </CardContent>
      </Card>

      <Card v-else-if="decided && approval">
        <CardHeader>
          <div class="flex items-center gap-2">
            <Check class="size-5 text-emerald-500" />
            <CardTitle class="text-base">{{ $t("approvals.decidedTitle") }}</CardTitle>
          </div>
        </CardHeader>
        <CardContent class="space-y-3 text-sm">
          <p>
            <Badge :variant="decided === 'approved' ? 'default' : 'secondary'">{{ t('approvals.decided.' + decided) }}</Badge>
            {{ t('approvals.for') }} <code>{{ approval.agent }}</code> · <code>{{ approval.capability }}</code>
          </p>
          <NuxtLink
            :to="`/specs/${approval.slug}/runtime`"
            class="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {{ $t("approvals.toRuntime") }} <ArrowUpRight class="size-3.5" />
          </NuxtLink>
        </CardContent>
      </Card>

      <Card v-else-if="approval">
        <CardHeader>
          <div class="flex items-center gap-2">
            <ShieldQuestion class="size-5 text-primary" />
            <CardTitle class="text-base">{{ $t("approvals.title") }}</CardTitle>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ $t("approvals.desc") }}
          </p>
        </CardHeader>
        <CardContent class="space-y-4">
          <dl class="space-y-2 text-sm">
            <div>
              <dt class="text-xs uppercase tracking-wider text-muted-foreground">{{ $t("approvals.project") }}</dt>
              <dd><code>{{ approval.slug }}</code></dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wider text-muted-foreground">{{ $t("approvals.agent") }}</dt>
              <dd><code>{{ approval.agent }}</code></dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wider text-muted-foreground">{{ $t("approvals.capability") }}</dt>
              <dd><code>{{ approval.capability }}</code></dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wider text-muted-foreground">{{ $t("approvals.requestId") }}</dt>
              <dd class="break-all font-mono text-xs text-muted-foreground">{{ approval.requestId }}</dd>
            </div>
          </dl>

          <div v-if="submitError" class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <p class="font-medium text-amber-700 dark:text-amber-400">{{ $t("approvals.saveError") }}</p>
            <p class="text-xs text-muted-foreground">{{ submitError }}</p>
          </div>

          <div class="grid gap-2">
            <Button
              :disabled="submitting"
              class="bg-emerald-600 hover:bg-emerald-700"
              @click="decide('approved')"
            >
              <Check class="mr-1.5 size-4" /> {{ $t("approvals.approve") }}
            </Button>
            <Button
              :disabled="submitting"
              variant="outline"
              class="border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-700"
              @click="decide('denied')"
            >
              <X class="mr-1.5 size-4" /> {{ $t("approvals.deny") }}
            </Button>
            <button
              :disabled="submitting"
              class="text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-50"
              @click="decide('escalated')"
            >
              {{ $t("approvals.escalate", { role: approval.agent }) }}
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
