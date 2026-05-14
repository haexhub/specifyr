<script setup lang="ts">
import { TabsContent as TabsContentPrimitive, type TabsContentProps, useForwardProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { cn } from "~/utils/utils"

const props = defineProps<TabsContentProps & { class?: HTMLAttributes["class"] }>()

const delegated = computed(() => {
  const { class: _, ...rest } = props
  return rest
})

const forwarded = useForwardProps(delegated)
</script>

<template>
  <TabsContentPrimitive
    v-bind="forwarded"
    :class="cn('ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', props.class)"
  >
    <slot />
  </TabsContentPrimitive>
</template>
