<script setup lang="ts">
defineProps<{
  loading: boolean;
  error: string | null;
  empty?: boolean;
  emptyMessage?: string;
}>();
</script>

<template>
  <div v-if="loading" class="state state--loading" role="status">
    <span class="spinner" aria-hidden="true"></span>กำลังโหลดข้อมูล…
  </div>
  <div v-else-if="error" class="state state--error" role="alert">{{ error }}</div>
  <div v-else-if="empty" class="state state--empty">{{ emptyMessage ?? 'ไม่มีข้อมูล' }}</div>
  <slot v-else />
</template>
