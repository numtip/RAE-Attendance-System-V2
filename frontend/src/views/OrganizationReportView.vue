<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, api, downloadOrganizationReport } from '../api/client';
import type { OrganizationReport } from '../api/types';
import AsyncState from '../components/AsyncState.vue';

const now = new Date();
const year = ref(now.getUTCFullYear());
const month = ref(now.getUTCMonth() + 1);

const loading = ref(false);
const error = ref<string | null>(null);
const exportError = ref<string | null>(null);
const report = ref<OrganizationReport | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  exportError.value = null;
  report.value = null;
  try {
    report.value = await api.organizationReport(year.value, month.value);
  } catch (e) {
    error.value = e instanceof ApiError && e.status === 403
      ? 'ไม่มีสิทธิ์ดูรายงานองค์กร/ทีม — ต้องเป็นผู้บริหารหรือผู้จัดการที่ได้รับสิทธิ์'
      : (e instanceof ApiError ? e.message : 'Failed to load report');
  } finally {
    loading.value = false;
  }
}

async function download(format: 'pdf' | 'xlsx') {
  exportError.value = null;
  try {
    await downloadOrganizationReport(year.value, month.value, format);
  } catch (e) {
    exportError.value = e instanceof ApiError ? e.message : 'Export failed';
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>รายงานองค์กร / ทีม</h2>
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
        <p class="muted">
          {{ report.scope === 'organization' ? 'ทั้งองค์กร' : 'ทีมของท่าน' }} · {{ report.periodLabel }}
        </p>
        <p class="muted">{{ report.notices.absenceNote }}</p>
        <dl class="detail-grid">
          <div><dt>พนักงานในขอบเขต</dt><dd>{{ report.totals.employeesInScope }}</dd></div>
          <div><dt>มีสรุปรายเดือน</dt><dd>{{ report.totals.employeesWithData }}</dd></div>
          <div><dt>ไม่มีสรุป</dt><dd>{{ report.totals.employeesWithoutData }}</dd></div>
          <div><dt>มาทำงาน (รวม)</dt><dd>{{ report.totals.present }}</dd></div>
          <div><dt>สาย (รวม)</dt><dd>{{ report.totals.late }} ({{ report.totals.lateMinutes }} นาที)</dd></div>
          <div><dt>ลา (รวม)</dt><dd>{{ report.totals.leaveDaysOnSummary }}</dd></div>
          <div><dt>ขาด</dt><dd>ยังไม่คำนวณ</dd></div>
        </dl>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>รหัส</th><th>ชื่อ-นามสกุล</th><th>วันทำงาน</th><th>มาทำงาน</th>
                <th>สาย</th><th>นาทีสาย</th><th>ลา</th><th>ขาด</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in report.rows" :key="row.employeeId">
                <td>{{ row.employeeId }}</td>
                <td>{{ row.employeeName }}</td>
                <template v-if="row.hasMonthlySummary">
                  <td>{{ row.workDays }}</td>
                  <td>{{ row.present }}</td>
                  <td>{{ row.late }}</td>
                  <td>{{ row.lateMinutes }}</td>
                  <td>{{ row.leaveDaysOnSummary }}</td>
                </template>
                <td v-else colspan="5" class="muted">ไม่มีสรุปรายเดือนที่บันทึกไว้</td>
                <td>ยังไม่คำนวณ</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </AsyncState>
  </section>
</template>
