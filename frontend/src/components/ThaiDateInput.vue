<script setup lang="ts">
import { computed } from 'vue';
import { THAI_MONTHS, buddhistYear, buddhistYearOptions, gregorianYear } from '../utils/thai';

// Thai date picker: day / month (Thai names) / year (พ.ศ.) selects. The model is an ISO (CE) date string,
// so the API and all internal logic keep using YYYY-MM-DD; only the labels are Buddhist Era.
const model = defineModel<string>({ required: true });
const props = defineProps<{ label?: string; span?: number }>();

const nowCe = new Date().getUTCFullYear();

function parse(value: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  return { y: nowCe, m: 1, d: 1 };
}

const parts = computed(() => parse(model.value));
const years = computed(() => {
  const list = buddhistYearOptions(nowCe, props.span ?? 10);
  const current = buddhistYear(parts.value.y);
  return list.includes(current) ? list : [...list, current].sort((a, b) => b - a);
});
const daysInMonth = computed(() => new Date(Date.UTC(parts.value.y, parts.value.m, 0)).getUTCDate());

function commit(y: number, m: number, d: number) {
  const maxDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(d, maxDay);
  model.value = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const onDay = (e: Event) => commit(parts.value.y, parts.value.m, Number((e.target as HTMLSelectElement).value));
const onMonth = (e: Event) => commit(parts.value.y, Number((e.target as HTMLSelectElement).value), parts.value.d);
const onYear = (e: Event) => commit(gregorianYear(Number((e.target as HTMLSelectElement).value)), parts.value.m, parts.value.d);
</script>

<template>
  <fieldset class="thai-date">
    <legend>{{ label ?? 'วันที่' }}</legend>
    <select :value="parts.d" aria-label="วัน" @change="onDay">
      <option v-for="d in daysInMonth" :key="d" :value="d">{{ d }}</option>
    </select>
    <select :value="parts.m" aria-label="เดือน" @change="onMonth">
      <option v-for="(name, i) in THAI_MONTHS" :key="name" :value="i + 1">{{ name }}</option>
    </select>
    <select :value="buddhistYear(parts.y)" aria-label="ปี พ.ศ." @change="onYear">
      <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
    </select>
  </fieldset>
</template>
