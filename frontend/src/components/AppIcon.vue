<script setup lang="ts">
import { computed } from 'vue';

// Small in-repo stroke icon set (24x24, no dependency). Decorative: the visible text always carries the meaning.
const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const ICONS: Record<string, string[]> = {
  profile: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', circle(12, 7, 4)],
  'attendance-daily': ['M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M16 2v4M8 2v4M3 10h18', 'M8 14h.01M12 14h.01'],
  'attendance-monthly': ['M3 3v18h18', 'M8 16v-4M13 16V8M18 16v-6'],
  reports: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6M8 13h8M8 17h6'],
  'leave-monthly': ['M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M16 2v4M8 2v4M3 10h18', 'M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01'],
  'leave-list': ['M8 6h13M8 12h13M8 18h13', 'M3 6h.01M3 12h.01M3 18h.01'],
  'leave-balance': ['M21 12a9 9 0 1 1-9-9', 'M12 3v9h9'],
  'leave-history': [circle(12, 12, 9), 'M12 7v5l3 2'],
  dashboard: ['M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z'],
  'reports-organization': ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', circle(9, 7, 4), 'M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'],
  'leave-review': ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  close: ['M18 6 6 18M6 6l12 12'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5M21 12H9'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'],
  clock: [circle(12, 12, 9), 'M12 7v5l3 2'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
};

const props = defineProps<{ name: string }>();
const paths = computed(() => ICONS[props.name] ?? []);
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path v-for="d in paths" :key="d" :d="d" />
  </svg>
</template>
