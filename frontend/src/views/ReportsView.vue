<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api, downloadPersonalReport } from '../api/client';
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
const exportError = ref<string | null>(null);
const report = ref<PersonalReport | null>(null);

async function load() {
  if (!employeeUid.value) {
    error.value = 'Missing employee context. Sign in again.';
    return;
  }
  loading.value = true;
  error.value = null;
  exportError.value = null;
  report.value = null;
  try {
    report.value = await api.personalReport(year.value, month.value);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Failed to load report';
  } finally {
    loading.value = false;
  }
}

async function download(format: 'pdf' | 'xlsx') {
  exportError.value = null;
  try {
    await downloadPersonalReport(year.value, month.value, format);
  } catch (e) {
    exportError.value = e instanceof ApiError ? e.message : 'Export failed';
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>รายงานของฉัน</h2>
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
        <button type="button" class="btn" :disabled="loading || !report" @click="download('pdf')">PDF</button>
        <button type="button" class="btn" :disabled="loading || !report" @click="download('xlsx')">Excel</button>
      </div>
    </div>
    <p v-if="exportError" class="form-error" role="alert">{{ exportError }}</p>
    <AsyncState :loading="loading" :error="error" :empty="false">
      <template v-if="report">
        <p class="muted">{{ report.employeeName }} ({{ report.employeeId }}) · {{ report.periodLabel }}</p>
        <p v-if="report.empty" class="state state--empty">ไม่มีข้อมูลการมาทำงานหรือการลาในช่วงนี้</p>
        <template v-else>
          <p v-if="!report.hasMonthlySummary" class="state state--empty">ไม่มีสรุปรายเดือนที่บันทึกไว้</p>
          <dl v-else class="detail-grid">
            <div><dt>มาทำงาน</dt><dd>{{ report.present }} / {{ report.workDays }}</dd></div>
            <div><dt>สาย</dt><dd>{{ report.late }} ({{ report.lateMinutes }} นาที)</dd></div>
            <div><dt>ขาด</dt><dd>{{ report.absent }}</dd></div>
            <div><dt>ลาตามสรุป</dt><dd>{{ report.leaveDaysOnSummary }}</dd></div>
            <div><dt>วันลาคงเหลือ</dt><dd>{{ report.remainingLeaveDays ?? '—' }}</dd></div>
          </dl>
          <h3>รายการสแกน</h3>
          <p v-if="report.scans.length === 0">ไม่มีรายการสแกนที่บันทึกไว้</p>
          <ul v-else>
            <li v-for="scan in report.scans" :key="scan.date">
              {{ scan.dateLabel }} เข้า {{ scan.checkInLabel }} ออก {{ scan.checkOutLabel }} {{ scan.statusLabel }}
            </li>
          </ul>
          <h3>รายการลา</h3>
          <p v-if="report.leaveRows.length === 0">ไม่มีรายการลาที่บันทึกไว้</p>
          <ul v-else>
            <li v-for="row in report.leaveRows" :key="`${row.startLabel}-${row.typeLabel}`">
              {{ row.typeLabel }} {{ row.startLabel }} – {{ row.endLabel }} {{ row.statusLabel }}
            </li>
          </ul>
        </template>
      </template>
    </AsyncState>
  </section>
</template>
