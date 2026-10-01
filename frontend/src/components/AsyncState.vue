<script setup lang="ts">
defineProps<{
  loading: boolean;
  error: string | null;
  empty?: boolean;
  emptyMessage?: string;
}>();
</script>

<template>
  <div v-if="loading" class="state state--loading" role="status">Loading…</div>
  <div v-else-if="error" class="state state--error" role="alert">{{ error }}</div>
  <div v-else-if="empty" class="state state--empty">{{ emptyMessage ?? 'No data.' }}</div>
  <slot v-else />
</template>
