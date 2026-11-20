<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { AttendanceRecord, MonthlySummary } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';
import KpiTile from '../components/KpiTile.vue';
import PeriodPicker from '../components/PeriodPicker.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusChip from '../components/StatusChip.vue';

const now = new Date();
const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');
const year = ref(now.getUTCFullYear());
const month = ref(now.getUTCMonth() + 1);

const loading = ref(false);
const error = ref<string | null>(null);
const summary = ref<MonthlySummary | null>(null);
const events = ref<AttendanceRecord[]>([]);

function inMonth(date: string): boolean {
  const [rowYear, rowMonth] = date.split('-').map(Number);
  return rowYear === year.value && rowMonth === month.value;
}

function label(row: AttendanceRecord): string {
  if (row.status === 'late') return 'สาย';
  if (row.status === 'present') return 'มาทำงาน';
  if (!row.checkIn && row.checkOut) return 'กลับก่อน';
  return row.status;
}

async function load() {
  if (!employeeUid.value) {
    error.value = 'ไม่พบข้อมูลผู้ใช้ กรุณาเข้าสู่ระบบใหม่';
    return;
  }
  loading.value = true;
  error.value = null;
  summary.value = null;
  events.value = [];
  try {
    summary.value = await api.attendanceMonthly(employeeUid.value, year.value, month.value);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) {
      error.value = e instanceof ApiError ? e.message : 'ไม่สามารถโหลดสรุปรายเดือนได้';
      loading.value = false;
      return;
    }
  }
  try {
    const rows = await api.employeeAttendance(employeeUid.value);
    events.value = rows.filter((row) => inMonth(row.date));
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) {
      error.value = e instanceof ApiError ? e.message : 'ไม่สามารถโหลดรายการลงเวลาได้';
    }
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="งานของฉัน" title="สรุปรายเดือน" subtitle="สรุปการมาทำงาน การมาสาย และการลาของท่านในเดือนที่เลือก" />
    <PeriodPicker v-model:year="year" v-model:month="month" :loading="loading" submit-label="แสดงสรุป" @submit="load" />
    <AsyncState :loading="loading" :error="error" :empty="false">
      <p v-if="!summary && !loading && !error" class="state state--empty">ไม่มีสรุปรายเดือนที่บันทึกไว้</p>
      <template v-if="summary">
        <p class="callout" role="note">
          จำนวนวันทำงานยังไม่หักวันหยุดนักขัตฤกษ์
        </p>
        <dl class="kpi-grid">
          <KpiTile label="มาทำงาน" :value="summary.totalPresent" :hint="`จาก ${summary.totalWorkDays} วันทำงาน`" />
          <KpiTile label="มาสาย" tone="late" :value="summary.totalLate" :hint="`รวม ${summary.totalLateMinutes} นาที`" />
          <KpiTile label="ลา" tone="leave" :value="summary.totalLeave" hint="วัน" />
          <KpiTile label="ชั่วโมงทำงานรวม" :value="summary.totalWorkHours" hint="ชั่วโมง" />
        </dl>
      </template>
      <p v-if="!loading && !error && events.length === 0" class="muted">ไม่มีรายการที่บันทึกไว้ในเดือนนี้</p>
      <div v-else-if="events.length" class="table-scroll">
        <table class="data-table data-table--stack">
          <thead><tr><th>วันที่</th><th>สถานะ</th></tr></thead>
          <tbody>
            <tr v-for="row in events" :key="row.date">
              <td data-label="วันที่">{{ row.date }}</td>
              <td data-label="สถานะ"><StatusChip :label="label(row)" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </AsyncState>
  </section>
</template>
