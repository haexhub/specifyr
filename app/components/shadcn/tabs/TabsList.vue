<script setup lang="ts">
import { TabsList as TabsListPrimitive, type TabsListProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { cn } from "~/utils/utils"

const props = defineProps<TabsListProps & { class?: HTMLAttributes["class"] }>()

const delegated = computed(() => {
  const { class: _, ...rest } = props
  return rest
})
</script>

<template>
  <TabsListPrimitive
    v-bind="delegated"
    :class="cn('inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground', props.class)"
  >
    <slot />
  </TabsListPrimitive>
</template>
