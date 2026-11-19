<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api, downloadPersonalReport } from '../api/client';
import type { PersonalReport } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';
import KpiTile from '../components/KpiTile.vue';
import PeriodPicker from '../components/PeriodPicker.vue';
import StatusChip from '../components/StatusChip.vue';
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
    error.value = 'ไม่พบข้อมูลผู้ใช้ กรุณาเข้าสู่ระบบใหม่';
    return;
  }
  loading.value = true;
  error.value = null;
  exportError.value = null;
  report.value = null;
  try {
    report.value = await api.personalReport(year.value, month.value);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'ไม่สามารถโหลดรายงานได้';
  } finally {
    loading.value = false;
  }
}

async function download(format: 'pdf' | 'xlsx') {
  exportError.value = null;
  try {
    await downloadPersonalReport(year.value, month.value, format);
  } catch (e) {
    exportError.value = e instanceof ApiError ? e.message : 'ส่งออกรายงานไม่สำเร็จ';
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="page-head">
      <h2>รายงานของฉัน</h2>
      <div class="actions">
        <button type="button" class="btn" :disabled="loading || !report" @click="download('pdf')">ส่งออก PDF</button>
        <button type="button" class="btn" :disabled="loading || !report" @click="download('xlsx')">ส่งออก Excel</button>
      </div>
    </div>
    <PeriodPicker v-model:year="year" v-model:month="month" :loading="loading" @submit="load" />
    <p v-if="exportError" class="form-error" role="alert">{{ exportError }}</p>
    <AsyncState :loading="loading" :error="error" :empty="false">
      <template v-if="report">
        <h3 class="section-title">{{ report.employeeName }} <span class="muted">({{ report.employeeId }})</span></h3>
        <p class="muted">{{ report.periodLabel }}</p>
        <p v-if="report.dataThrough?.partial" class="callout" role="alert">{{ report.dataThrough.note }}</p>
        <p v-else-if="report.dataThrough?.label" class="muted">{{ report.dataThrough.label }}</p>
        <p class="callout" role="note">{{ report.notices.holidayNote }}</p>
        <p v-if="report.empty" class="state state--empty">ไม่มีข้อมูลการมาทำงานหรือการลาในช่วงนี้</p>
        <template v-else>
          <p v-if="!report.hasMonthlySummary" class="state state--empty">ไม่มีสรุปรายเดือนที่บันทึกไว้</p>
          <dl v-else class="kpi-grid">
            <KpiTile label="มาทำงาน" :value="report.present ?? '—'" :hint="`จาก ${report.workDays ?? '—'} วันทำงาน`" />
            <KpiTile label="มาสาย" :value="report.late ?? '—'" :hint="`รวม ${report.lateMinutes ?? 0} นาที`" />
            <KpiTile label="ลา (บันทึกจาก HIP)" :value="report.leaveRecordedDays ?? '—'" :hint="report.leaveRecordedDays === null ? 'เดือนนี้ยังไม่มีข้อมูลการลา' : `วัน — ยังไม่ยืนยันอนุมัติ${report.leaveNeedsReview ? ` · รอตรวจสอบ ${report.leaveNeedsReview}` : ''}`" />
            <KpiTile label="วันลาคงเหลือ" :value="report.remainingLeaveDays ?? '—'" hint="วัน" />
          </dl>
          <h3 class="section-title">รายการสแกน</h3>
          <p v-if="report.scans.length === 0" class="muted">ไม่มีรายการสแกนที่บันทึกไว้</p>
          <div v-else class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>วันที่</th><th>เวลาเข้า</th><th>เวลาออก</th><th>สถานะ</th><th class="num">สาย (นาที)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="scan in report.scans" :key="scan.date">
                  <td>{{ scan.dateLabel }}</td>
                  <td>{{ scan.checkInLabel }}</td>
                  <td>{{ scan.checkOutLabel }}</td>
                  <td><StatusChip :label="scan.statusLabel" /></td>
                  <td class="num">{{ scan.lateMinutes ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <h3 class="section-title">รายการลา</h3>
          <p v-if="report.leaveRows.length === 0" class="muted">ไม่มีรายการลาที่บันทึกไว้</p>
          <div v-else class="table-scroll">
            <table class="data-table">
              <thead>
                <tr><th>ประเภท</th><th>เริ่ม</th><th>สิ้นสุด</th><th>สถานะ</th></tr>
              </thead>
              <tbody>
                <tr v-for="row in report.leaveRows" :key="`${row.startLabel}-${row.typeLabel}`">
                  <td>{{ row.typeLabel }}</td>
                  <td>{{ row.startLabel }}</td>
                  <td>{{ row.endLabel }}</td>
                  <td>{{ row.statusLabel }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>
    </AsyncState>
  </section>
</template>
