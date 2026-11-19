<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { AttendanceRecord } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';
import StatusChip from '../components/StatusChip.vue';
import { roleLabel } from '../utils/thai';

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
    error.value = e instanceof ApiError ? e.message : 'ไม่สามารถโหลดข้อมูลลงเวลาได้';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="page-head">
      <h2>ลงเวลารายวัน</h2>
      <form class="period" @submit.prevent="load">
        <label class="field">
          <span>วันที่</span>
          <input v-model="date" type="date" />
        </label>
        <button type="submit" class="btn btn--primary" :disabled="loading">{{ loading ? 'กำลังโหลด…' : 'แสดงข้อมูล' }}</button>
      </form>
    </div>
    <p class="muted">
      สิทธิ์ของท่าน: <strong>{{ roleLabel(employee?.role) }}</strong> — ระบบแสดงข้อมูลตามสิทธิ์
      (ผู้บริหาร/หัวหน้าที่ได้รับสิทธิ์เห็นทั้งหน่วย; พนักงานเห็นเฉพาะของตนเอง)
    </p>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="ไม่มีรายการลงเวลาในวันนี้"
    >
      <div v-if="rows.length" class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>พนักงาน</th><th>วันที่</th><th>เวลาเข้า</th><th>เวลาออก</th><th>สถานะ</th><th class="num">สาย (นาที)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="`${row.employeeUid}-${row.date}`">
              <td><code>{{ row.employeeUid.slice(0, 8) }}…</code></td>
              <td>{{ row.date }}</td>
              <td>{{ bangkokTime(row.checkIn) }}</td>
              <td>{{ bangkokTime(row.checkOut) }}</td>
              <td><StatusChip :label="statusLabel(row.status)" /></td>
              <td class="num">{{ row.lateMinutes ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </AsyncState>
  </section>
</template>
