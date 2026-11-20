<script setup lang="ts">
defineProps<{
  loading: boolean;
  error: string | null;
  empty?: boolean;
  emptyMessage?: string;
}>();
</script>

<template>
  <div v-if="loading" class="state state--loading" role="status" aria-live="polite">
    <span class="state-label"><span class="spinner" aria-hidden="true"></span>กำลังโหลดข้อมูล…</span>
    <span class="skeleton" aria-hidden="true">
      <span class="skeleton-row skeleton-row--lg"></span>
      <span class="skeleton-row"></span>
      <span class="skeleton-row" style="width: 70%"></span>
    </span>
  </div>
  <div v-else-if="error" class="state state--error" role="alert">{{ error }}</div>
  <div v-else-if="empty" class="state state--empty">{{ emptyMessage ?? 'ไม่มีข้อมูล' }}</div>
  <slot v-else />
</template>
