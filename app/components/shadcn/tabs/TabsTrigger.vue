<script setup lang="ts">
import { TabsTrigger as TabsTriggerPrimitive, type TabsTriggerProps, useForwardProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { cn } from "~/utils/utils"

const props = defineProps<TabsTriggerProps & { class?: HTMLAttributes["class"] }>()

const delegated = computed(() => {
  const { class: _, ...rest } = props
  return rest
})

const forwarded = useForwardProps(delegated)
</script>

<template>
  <TabsTriggerPrimitive
    v-bind="forwarded"
    :class="cn('inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow', props.class)"
  >
    <slot />
  </TabsTriggerPrimitive>
</template>
