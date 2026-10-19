<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { PersonalReport } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';
import { isReviewFixtureMode } from '../config/reviewMode';

const now = new Date();
const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');
const year = ref(isReviewFixtureMode ? 2026 : now.getUTCFullYear());
const month = ref(isReviewFixtureMode ? 3 : now.getUTCMonth() + 1);

const loading = ref(false);
const error = ref<string | null>(null);
const report = ref<PersonalReport | null>(null);

async function load() {
  if (!employeeUid.value) {
    error.value = 'Missing employee context. Sign in again.';
    return;
  }
  loading.value = true;
  error.value = null;
  report.value = null;
  try {
    report.value = await api.personalReport(year.value, month.value);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Failed to load report';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>My report</h2>
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
    <AsyncState :loading="loading" :error="error" :empty="!report && !loading && !error">
      <dl v-if="report" class="detail-grid">
        <div><dt>Present</dt><dd>{{ report.present }} / {{ report.workDays }}</dd></div>
        <div><dt>Late</dt><dd>{{ report.late }}</dd></div>
        <div><dt>Absent</dt><dd>{{ report.absent }}</dd></div>
        <div><dt>Leave on summary</dt><dd>{{ report.leaveDaysOnSummary }}</dd></div>
        <div><dt>Leave rows this month</dt><dd>{{ report.leaveRowsInMonth }}</dd></div>
        <div><dt>Leave remaining</dt><dd>{{ report.remainingLeaveDays }}</dd></div>
      </dl>
    </AsyncState>
  </section>
</template>
