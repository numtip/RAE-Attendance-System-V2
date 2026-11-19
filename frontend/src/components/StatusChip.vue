<script setup lang="ts">
import { statusTone } from '../utils/thai';

defineProps<{ label: string }>();
</script>

<template>
  <span class="chip" :class="`chip--${statusTone(label)}`">{{ label }}</span>
</template>
