<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { LeaveRow } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusChip from '../components/StatusChip.vue';
import { leaveStatusLabel } from '../utils/thai';

const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');

const loading = ref(true);
const error = ref<string | null>(null);
const rows = ref<LeaveRow[]>([]);

async function load() {
  if (!employeeUid.value) {
    error.value = 'ไม่พบข้อมูลผู้ใช้ กรุณาเข้าสู่ระบบใหม่';
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.leaveHistory(employeeUid.value);
  } catch (e) {
    rows.value = [];
    error.value = e instanceof ApiError ? e.message : 'ไม่สามารถโหลดประวัติการลาได้';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="การลา" title="ประวัติการลา" subtitle="ประวัติการลาย้อนหลังของท่าน พร้อมสถานะการจับคู่ข้อมูล">
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">โหลดใหม่</button>
    </PageHeader>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="ไม่มีประวัติการลา"
    >
      <div v-if="rows.length" class="table-scroll">
        <table class="data-table data-table--stack">
          <thead>
            <tr><th>เลขที่</th><th>ประเภท</th><th>เริ่ม</th><th>สิ้นสุด</th><th>สถานะ</th><th>การจับคู่</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.leaveId">
              <td data-label="เลขที่">{{ row.leaveId }}</td>
              <td data-label="ประเภท">{{ row.leaveType }}</td>
              <td data-label="เริ่ม">{{ row.startDate }}</td>
              <td data-label="สิ้นสุด">{{ row.endDate }}</td>
              <td data-label="สถานะ"><StatusChip :label="leaveStatusLabel(row.status)" /></td>
              <td data-label="การจับคู่">{{ row.matchStatus ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </AsyncState>
  </section>
</template>
