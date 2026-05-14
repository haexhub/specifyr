<script setup lang="ts">
import { TabsRoot, type TabsRootEmits, type TabsRootProps, useForwardPropsEmits } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { cn } from "~/utils/utils"

const props = defineProps<TabsRootProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<TabsRootEmits>()

const delegated = computed(() => {
  const { class: _, ...rest } = props
  return rest
})

const forwarded = useForwardPropsEmits(delegated, emits)
</script>

<template>
  <TabsRoot v-bind="forwarded" :class="cn('flex flex-col gap-2', props.class)">
    <slot />
  </TabsRoot>
</template>
