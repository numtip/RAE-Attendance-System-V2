<script setup lang="ts">
import { computed } from 'vue';
import { buddhistYear, buddhistYearOptions, gregorianYear } from '../utils/thai';

// Year picker shown in พ.ศ. only. The model stays the Gregorian (ค.ศ.) year used by the API (BE − 543).
const year = defineModel<number>({ required: true });

const options = computed(() => {
  const list = buddhistYearOptions(new Date().getUTCFullYear(), 10);
  const current = buddhistYear(year.value);
  return list.includes(current) ? list : [...list, current].sort((a, b) => b - a);
});
</script>

<template>
  <label class="field">
    <span>ปี (พ.ศ.)</span>
    <select :value="buddhistYear(year)" @change="year = gregorianYear(Number(($event.target as HTMLSelectElement).value))">
      <option v-for="y in options" :key="y" :value="y">{{ y }}</option>
    </select>
  </label>
</template>
