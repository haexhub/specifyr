<script setup lang="ts">
import { AlertTriangle, X } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message?: string;
    details?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    busy?: boolean;
  }>(),
  {
    confirmLabel: undefined,
    cancelLabel: undefined,
    destructive: false,
    busy: false
  }
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  confirm: [];
  cancel: [];
}>();

const { t } = useI18n();

const resolvedConfirmLabel = computed(() => props.confirmLabel ?? t("confirmDialog.defaultConfirm"));
const resolvedCancelLabel = computed(() => props.cancelLabel ?? t("confirmDialog.defaultCancel"));

function close() {
  if (props.busy) return;
  emit("cancel");
  emit("update:open", false);
}

function confirm() {
  if (props.busy) return;
  emit("confirm");
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        role="dialog"
        aria-modal="true"
        class="relative w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-xl"
      >
        <button
          type="button"
          class="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          :disabled="busy"
          @click="close"
        >
          <X class="size-4" />
        </button>

        <div class="flex items-start gap-3">
          <div
            v-if="destructive"
            class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive"
          >
            <AlertTriangle class="size-5" />
          </div>
          <div class="flex-1 space-y-1.5">
            <h2 class="text-lg font-semibold">{{ title }}</h2>
            <p v-if="message" class="text-sm text-muted-foreground">{{ message }}</p>
            <p v-if="details" class="text-xs text-muted-foreground">
              <slot name="details">{{ details }}</slot>
            </p>
          </div>
        </div>

        <slot />

        <div class="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" :disabled="busy" @click="close">
            {{ resolvedCancelLabel }}
          </Button>
          <Button
            type="button"
            :variant="destructive ? 'destructive' : 'default'"
            :disabled="busy"
            @click="confirm"
          >
            {{ busy ? $t("common.working") : resolvedConfirmLabel }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
