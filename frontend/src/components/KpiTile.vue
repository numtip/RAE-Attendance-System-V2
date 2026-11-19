<script setup lang="ts">
defineProps<{ label: string; value: string | number; hint?: string; tone?: 'default' | 'info' }>();
</script>

<template>
  <div class="kpi" :class="{ 'kpi--info': tone === 'info' }">
    <dt class="kpi-label">{{ label }}</dt>
    <dd class="kpi-value">{{ value }}</dd>
    <dd v-if="hint" class="kpi-hint">{{ hint }}</dd>
  </div>
</template>
