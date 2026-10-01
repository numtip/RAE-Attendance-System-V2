<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { MonthlySummary } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';

const now = new Date();
const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');
const year = ref(now.getUTCFullYear());
const month = ref(now.getUTCMonth() + 1);

const loading = ref(false);
const error = ref<string | null>(null);
const summary = ref<MonthlySummary | null>(null);

async function load() {
  if (!employeeUid.value) {
    error.value = 'Missing employee context. Sign in again.';
    return;
  }
  loading.value = true;
  error.value = null;
  summary.value = null;
  try {
    summary.value = await api.attendanceMonthly(employeeUid.value, year.value, month.value);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Failed to load monthly summary';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>Monthly attendance</h2>
      <div class="inline-controls">
        <label class="field field--inline">
          <span>Year</span>
          <input v-model.number="year" type="number" min="2000" max="2100" />
        </label>
        <label class="field field--inline">
          <span>Month</span>
          <input v-model.number="month" type="number" min="1" max="12" />
        </label>
        <button type="button" class="btn btn--primary" :disabled="loading" @click="load">Load</button>
      </div>
    </div>
    <AsyncState :loading="loading" :error="error" :empty="!summary && !loading && !error">
      <dl v-if="summary" class="detail-grid">
        <div><dt>Present</dt><dd>{{ summary.totalPresent }} / {{ summary.totalWorkDays }}</dd></div>
        <div><dt>Late</dt><dd>{{ summary.totalLate }} ({{ summary.totalLateMinutes }} min)</dd></div>
        <div><dt>Absent</dt><dd>{{ summary.totalAbsent }}</dd></div>
        <div><dt>Leave</dt><dd>{{ summary.totalLeave }}</dd></div>
        <div><dt>Work hours</dt><dd>{{ summary.totalWorkHours }}</dd></div>
      </dl>
    </AsyncState>
  </section>
</template>
