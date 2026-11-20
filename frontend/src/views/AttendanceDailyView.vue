<script setup lang="ts">
import { errorMessageTh } from '../utils/i18n';
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { AttendanceRecord } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';
import PageHeader from '../components/PageHeader.vue';
import KpiTile from '../components/KpiTile.vue';
import StatusChip from '../components/StatusChip.vue';
import { formatThaiDate, roleLabel } from '../utils/thai';
import ThaiDateInput from '../components/ThaiDateInput.vue';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// The API returns UTC instants; staff read the office clock.
function bangkokTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  });
}

function statusLabel(status: string): string {
  if (status === 'present') return 'มาทำงาน';
  if (status === 'late') return 'สาย';
  return status;
}

const date = ref(todayIso());
const loading = ref(false);
const error = ref<string | null>(null);
const rows = ref<AttendanceRecord[]>([]);
const employee = getStoredEmployee();

async function load() {
  loading.value = true;
  error.value = null;
  try {
    try {
      rows.value = await api.attendanceDaily(date.value);
    } catch (e) {
      // A staff member cannot see the whole organisation; the API answers 403 and their own day is
      // still readable. Ask for that instead of deciding the role in the browser.
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
      rows.value = await api.attendanceMe(date.value);
    }
  } catch (e) {
    rows.value = [];
    error.value = errorMessageTh(e, 'ไม่สามารถโหลดข้อมูลลงเวลาได้');
  } finally {
    loading.value = false;
  }
}

// Day navigation only changes the requested date; the same API call is used.
function shiftDay(delta: number) {
  const d = new Date(`${date.value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return;
  d.setUTCDate(d.getUTCDate() + delta);
  date.value = d.toISOString().slice(0, 10);
  void load();
}
function goToday() {
  date.value = todayIso();
  void load();
}
// Counts of the rows shown. There is no absence figure: a missing scan is "no data", never an inferred absence.
const counts = computed(() => ({
  total: rows.value.length,
  present: rows.value.filter((r) => r.status === 'present').length,
  late: rows.value.filter((r) => r.status === 'late').length,
}));

onMounted(load);
</script>

<template>
  <section>
    <PageHeader
      eyebrow="งานของฉัน"
      title="ลงเวลารายวัน"
      :subtitle="`สิทธิ์ของท่าน: ${roleLabel(employee?.role)} — ระบบแสดงข้อมูลตามสิทธิ์ (ผู้บริหาร/หัวหน้าที่ได้รับสิทธิ์เห็นทั้งหน่วย; พนักงานเห็นเฉพาะของตนเอง)`"
    />
    <form class="period" @submit.prevent="load">
      <div class="daynav">
        <button type="button" class="btn btn--ghost" aria-label="วันก่อนหน้า" :disabled="loading" @click="shiftDay(-1)">‹</button>
        <ThaiDateInput v-model="date" />
        <button type="button" class="btn btn--ghost" aria-label="วันถัดไป" :disabled="loading" @click="shiftDay(1)">›</button>
      </div>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="goToday">วันนี้</button>
      <button type="submit" class="btn btn--primary" :disabled="loading">{{ loading ? 'กำลังโหลด…' : 'แสดงข้อมูล' }}</button>
    </form>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="ไม่มีข้อมูลการสแกนในวันนี้ — ระบบไม่สรุปว่าเป็นการขาดงาน"
    >
      <template v-if="rows.length">
        <dl class="kpi-grid">
          <KpiTile label="รายการที่แสดง" :value="counts.total" hint="รายการลงเวลา" tone="info" />
          <KpiTile label="มาทำงาน" :value="counts.present" hint="ในรายการที่แสดง" />
          <KpiTile label="สาย" :value="counts.late" hint="ในรายการที่แสดง" tone="late" />
        </dl>
        <div class="table-scroll">
          <table class="data-table data-table--stack">
            <thead>
              <tr>
                <th class="sticky-col">พนักงาน</th><th>วันที่</th><th>เวลาเข้า</th><th>เวลาออก</th><th>สถานะ</th><th class="num">สาย (นาที)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="`${row.employeeUid}-${row.date}`">
                <td class="sticky-col" data-label="">
                  <template v-if="row.employeeName">
                    <strong>{{ row.employeeName }}</strong><br />
                    <span class="muted">{{ row.employeeId }}</span>
                  </template>
                  <span v-else class="muted">ไม่พบข้อมูลพนักงาน</span>
                </td>
                <td data-label="วันที่">{{ formatThaiDate(row.date) }}</td>
                <td data-label="เวลาเข้า">{{ bangkokTime(row.checkIn) }}</td>
                <td data-label="เวลาออก">{{ bangkokTime(row.checkOut) }}</td>
                <td data-label="สถานะ"><StatusChip :label="statusLabel(row.status)" /></td>
                <td class="num" data-label="สาย (นาที)">{{ row.lateMinutes ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </AsyncState>
  </section>
</template>
