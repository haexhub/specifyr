<script setup lang="ts">
defineProps<{
  compact?: boolean;
  showText?: boolean;
}>();
</script>

<template>
  <span class="inline-flex items-center gap-2 font-semibold text-foreground">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      role="img"
      aria-label="speculoss"
      class="shrink-0"
      :class="compact ? 'size-6' : 'size-7'"
    >
      <path d="M15.2 7.8h33.6l2.8 3.6 4.4 1.1 1 4.5 3.5 2.9-1.6 4.6 1.6 4.6-3.5 2.9-1 4.5-4.4 1.1-2.8 3.6H15.2l-2.8-3.6L8 40.6l-1-4.5-3.5-2.9 1.6-4.6-1.6-4.6L7 21.1l1-4.5 4.4-1.1 2.8-3.7Z" fill="#a95d29" />
      <path d="M17.5 11.5h29l2.4 3 3.9.9.9 3.9 3 2.4-1.4 4.1 1.4 4.1-3 2.4-.9 3.9-3.9.9-2.4 3h-29l-2.4-3-3.9-.9-.9-3.9-3-2.4 1.4-4.1-1.4-4.1 3-2.4.9-3.9 3.9-.9 2.4-3Z" fill="#d9924a" />
      <path d="M20.2 15.6h23.6M17.4 22.2h29.2M16.8 42.1h30.4M20.2 49h23.6" fill="none" stroke="#8a461f" stroke-linecap="round" stroke-width="1.7" opacity=".34" />
      <path d="M23.4 51.4h17.2M25 46.8h14M27.2 42.3h9.6" fill="none" stroke="#7b3919" stroke-linecap="round" stroke-width="2.1" />
      <path d="M25.8 51.4v-12c0-4.1 2.5-7 6.2-7s6.2 2.9 6.2 7v12" fill="none" stroke="#6f3216" stroke-linecap="round" stroke-linejoin="round" stroke-width="3.2" />
      <path d="M29.1 51.2v-11c0-2.1 1-3.5 2.9-3.5s2.9 1.4 2.9 3.5v11" fill="#c47a37" stroke="#f0bd79" stroke-linejoin="round" stroke-width="1.2" />
      <path d="M32 11.2v19M22.5 20.7h19M25.2 13.9l13.5 13.5M38.8 13.9 25.3 27.4" fill="none" stroke="#6f3216" stroke-linecap="round" stroke-width="3.2" />
      <path d="M32 11.2v19M22.5 20.7h19M25.2 13.9l13.5 13.5M38.8 13.9 25.3 27.4" fill="none" stroke="#f3be78" stroke-linecap="round" stroke-width="1.2" />
      <circle cx="32" cy="20.7" r="3" fill="#7b3919" />
      <circle cx="32" cy="20.7" r="1.4" fill="#efb66e" />
      <path d="M17.3 55.6h29.4M15 52.2h34M12.8 48.8h38.4" fill="none" stroke="#7b3919" stroke-linecap="round" stroke-width="2.3" />
      <path d="M20.7 32.9h4.7v6.2h-4.7zM38.6 32.9h4.7v6.2h-4.7z" fill="#b86d32" stroke="#f0bd79" stroke-linejoin="round" stroke-width="1.2" />
      <circle cx="15.9" cy="17.2" r="1" fill="#7b3919" opacity=".45" />
      <circle cx="48.4" cy="20.6" r=".9" fill="#7b3919" opacity=".38" />
      <circle cx="16.9" cy="35.9" r=".8" fill="#f4c27e" opacity=".75" />
      <circle cx="46.8" cy="45.3" r="1" fill="#7b3919" opacity=".4" />
      <circle cx="12.7" cy="28.3" r=".8" fill="#7b3919" opacity=".42" />
      <circle cx="51.7" cy="31.8" r=".7" fill="#f4c27e" opacity=".7" />
    </svg>
    <span v-if="showText !== false" class="truncate text-sm tracking-tight">
      speculoos
    </span>
  </span>
</template>
