<script setup lang="ts">
import { computed } from "vue";
import { CheckCircle2, Pencil, Trash2 } from "lucide-vue-next";
import { Button } from "~/components/shadcn/button";
import { Badge } from "~/components/shadcn/badge";
import type { ProviderIdentity } from "~/stores/provider-identity";

const props = defineProps<{
  identities: ProviderIdentity[];
  activeIdentityId: string | null;
}>();

const emit = defineEmits<{
  edit: [id: string];
  remove: [id: string];
  setActive: [id: string];
}>();

const sorted = computed(() =>
  [...props.identities].sort((a, b) => a.label.localeCompare(b.label)),
);
</script>

<template>
  <div v-if="!identities.length" class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
    No provider identities yet. Add one to use the Speckit browser agent.
  </div>

  <ul v-else class="space-y-2">
    <li
      v-for="identity in sorted"
      :key="identity.id"
      class="flex items-start justify-between gap-4 rounded-lg border border-border bg-card p-4"
    >
      <div class="min-w-0 space-y-1">
        <div class="flex items-center gap-2">
          <span class="font-medium">{{ identity.label }}</span>
          <Badge v-if="identity.id === activeIdentityId" variant="default">Active</Badge>
        </div>
        <div class="text-sm text-muted-foreground">
          <span class="capitalize">{{ identity.provider }}</span>
          <span class="px-1.5 opacity-50">·</span>
          <span class="font-mono">{{ identity.model }}</span>
        </div>
        <div v-if="identity.baseUrl" class="truncate text-xs text-muted-foreground">
          {{ identity.baseUrl }}
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <Button
          v-if="identity.id !== activeIdentityId"
          type="button"
          variant="ghost"
          size="sm"
          @click="emit('setActive', identity.id)"
        >
          <CheckCircle2 class="size-4" /> Set active
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Edit"
          @click="emit('edit', identity.id)"
        >
          <Pencil class="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete"
          @click="emit('remove', identity.id)"
        >
          <Trash2 class="size-4 text-destructive" />
        </Button>
      </div>
    </li>
  </ul>
</template>
