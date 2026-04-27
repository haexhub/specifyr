<script setup lang="ts">
// Approval-Detail-Page — Tap-Target des Telegram Deep-Links.
//
// Flow:
//   Telegram-Notification → Tap auf <APPROVAL_URL_BASE>/approvals/<requestId>
//   → diese Seite öffnet → User sieht Agent + Capability + Slug
//   → Tap auf Approve/Deny → POST /api/approvals/<id>/decide
//   → ApprovalService.resolve() → Worker entblockt
//
// Edge cases:
//   - 404 vom GET: Request existiert nicht (mehr) → "bereits entschieden"
//   - Resolve schlägt fehl (Race): zeige Fehlermeldung, page state bleibt
//   - Erfolg: zeige Bestätigung, redirect / link zurück zur Runtime-View

import { Check, X, ArrowUpRight, Loader2, ShieldQuestion, AlertTriangle } from "lucide-vue-next";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";

interface ApprovalDetail {
  requestId: string;
  slug: string;
  agent: string;
  capability: string;
}

type Decision = "approved" | "denied" | "escalated";

const route = useRoute();
const id = computed(() => route.params.id as string);

// Initial fetch — `useFetch` integrates with Nuxt's data layer for SSR-safety.
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
      // Race: zwischen GET und POST per timeout aufgelöst, oder anderer Tab
      // hat schneller geklickt. Spezifische Message statt generisch.
      submitError.value =
        "Dieser Approval wurde gerade aufgelöst (Timeout oder anderer Klient). Lade die Seite neu, um zu sehen ob noch etwas offen ist.";
    } else {
      submitError.value = e.statusMessage ?? e.message ?? "Unbekannter Fehler beim Speichern.";
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-6">
    <div class="w-full max-w-md">
      <!-- Loading -->
      <Card v-if="fetchPending && !approval">
        <CardContent class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" /> Lade Approval-Request…
        </CardContent>
      </Card>

      <!-- Not found / already decided -->
      <Card v-else-if="fetchError">
        <CardHeader>
          <div class="flex items-center gap-2">
            <AlertTriangle class="size-5 text-amber-500" />
            <CardTitle class="text-base">Request nicht gefunden</CardTitle>
          </div>
        </CardHeader>
        <CardContent class="space-y-3 text-sm text-muted-foreground">
          <p>
            Diese Approval-Anfrage ist nicht (mehr) offen — wahrscheinlich bereits entschieden,
            ge-timeout-et oder die ID ist unbekannt.
          </p>
          <p class="font-mono text-xs">{{ id }}</p>
          <NuxtLink to="/" class="inline-flex items-center gap-1 text-primary hover:underline">
            <ArrowUpRight class="size-3.5" /> Zur Übersicht
          </NuxtLink>
        </CardContent>
      </Card>

      <!-- Decided (success state) -->
      <Card v-else-if="decided && approval">
        <CardHeader>
          <div class="flex items-center gap-2">
            <Check class="size-5 text-emerald-500" />
            <CardTitle class="text-base">Entscheidung gespeichert</CardTitle>
          </div>
        </CardHeader>
        <CardContent class="space-y-3 text-sm">
          <p>
            <Badge :variant="decided === 'approved' ? 'default' : 'secondary'">{{ decided }}</Badge>
            für <code>{{ approval.agent }}</code> · <code>{{ approval.capability }}</code>
          </p>
          <NuxtLink
            :to="`/specs/${approval.slug}/runtime`"
            class="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Zur Runtime-View <ArrowUpRight class="size-3.5" />
          </NuxtLink>
        </CardContent>
      </Card>

      <!-- Decision UI -->
      <Card v-else-if="approval">
        <CardHeader>
          <div class="flex items-center gap-2">
            <ShieldQuestion class="size-5 text-primary" />
            <CardTitle class="text-base">Approval Request</CardTitle>
          </div>
          <p class="text-xs text-muted-foreground">
            Ein Agent fragt eine sensitive Capability an. Entscheide jetzt — der Worker blockiert,
            bis Antwort oder Timeout.
          </p>
        </CardHeader>
        <CardContent class="space-y-4">
          <dl class="space-y-2 text-sm">
            <div>
              <dt class="text-xs uppercase tracking-wider text-muted-foreground">Project</dt>
              <dd>
                <code>{{ approval.slug }}</code>
              </dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wider text-muted-foreground">Agent</dt>
              <dd>
                <code>{{ approval.agent }}</code>
              </dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wider text-muted-foreground">Capability</dt>
              <dd>
                <code>{{ approval.capability }}</code>
              </dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wider text-muted-foreground">Request ID</dt>
              <dd class="break-all font-mono text-xs text-muted-foreground">
                {{ approval.requestId }}
              </dd>
            </div>
          </dl>

          <div v-if="submitError" class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <p class="font-medium text-amber-700 dark:text-amber-400">Fehler beim Speichern</p>
            <p class="text-xs text-muted-foreground">{{ submitError }}</p>
          </div>

          <div class="grid gap-2">
            <Button
              :disabled="submitting"
              class="bg-emerald-600 hover:bg-emerald-700"
              @click="decide('approved')"
            >
              <Check class="mr-1.5 size-4" /> Approve
            </Button>
            <Button
              :disabled="submitting"
              variant="outline"
              class="border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-700"
              @click="decide('denied')"
            >
              <X class="mr-1.5 size-4" /> Deny
            </Button>
            <button
              :disabled="submitting"
              class="text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-50"
              @click="decide('escalated')"
            >
              Escalate to {{ approval.agent }}'s reports_to
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
