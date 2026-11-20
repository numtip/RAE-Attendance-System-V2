<script setup lang="ts">
import { THAI_MONTHS } from '../utils/thai';
import YearSelect from './YearSelect.vue';

defineProps<{ loading?: boolean; submitLabel?: string }>();
const year = defineModel<number>('year', { required: true });
const month = defineModel<number>('month', { required: true });
const emit = defineEmits<{ submit: [] }>();
</script>

<template>
  <form class="period" @submit.prevent="emit('submit')">
    <label class="field">
      <span>เดือน</span>
      <select v-model.number="month">
        <option v-for="(name, index) in THAI_MONTHS" :key="name" :value="index + 1">{{ name }}</option>
      </select>
    </label>
    <YearSelect v-model="year" />
    <button type="submit" class="btn btn--primary" :disabled="loading">
      {{ loading ? 'กำลังโหลด…' : (submitLabel ?? 'แสดงรายงาน') }}
    </button>
    <slot />
  </form>
</template>
