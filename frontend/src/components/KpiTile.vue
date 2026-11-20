<script setup lang="ts">
defineProps<{ label: string; value: string | number; hint?: string; tone?: 'default' | 'info' | 'late' | 'leave' }>();
</script>

<template>
  <div class="kpi" :class="tone && tone !== 'default' ? `kpi--${tone}` : undefined">
    <dt class="kpi-label">{{ label }}</dt>
    <dd class="kpi-value">{{ value }}</dd>
    <dd v-if="hint" class="kpi-hint">{{ hint }}</dd>
  </div>
</template>
