<script setup lang="ts">
defineProps<{ title: string; eyebrow?: string; subtitle?: string }>();
</script>

<template>
  <div class="page-head">
    <div class="page-head-text">
      <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
      <h2>{{ title }}</h2>
      <p v-if="subtitle" class="page-sub">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.default" class="actions"><slot /></div>
  </div>
</template>
