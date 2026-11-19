<script setup lang="ts">
import { THAI_MONTHS, buddhistYear } from '../utils/thai';

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
    <label class="field">
      <span>ปี (ค.ศ.) <em class="field-hint">พ.ศ. {{ buddhistYear(year) }}</em></span>
      <input v-model.number="year" type="number" min="2000" max="2100" inputmode="numeric" />
    </label>
    <button type="submit" class="btn btn--primary" :disabled="loading">
      {{ loading ? 'กำลังโหลด…' : (submitLabel ?? 'แสดงรายงาน') }}
    </button>
    <slot />
  </form>
</template>
