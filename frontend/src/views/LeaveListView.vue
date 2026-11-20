<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { LeaveRow } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import PageHeader from '../components/PageHeader.vue';
import StatusChip from '../components/StatusChip.vue';
import { leaveStatusLabel } from '../utils/thai';

const loading = ref(true);
const error = ref<string | null>(null);
const rows = ref<LeaveRow[]>([]);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.leaveList();
  } catch (e) {
    rows.value = [];
    error.value = e instanceof ApiError ? e.message : 'ไม่สามารถโหลดรายการลาได้';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="การลา" title="รายการลา" subtitle="รายการลาของท่านตามที่บันทึกในระบบ">
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">โหลดใหม่</button>
    </PageHeader>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="ไม่มีรายการลา"
    >
      <div v-if="rows.length" class="table-scroll">
        <table class="data-table data-table--stack">
          <thead>
            <tr><th>เลขที่</th><th>ประเภท</th><th>เริ่ม</th><th>สิ้นสุด</th><th>สถานะ</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.leaveId">
              <td data-label="เลขที่">{{ row.leaveId }}</td>
              <td data-label="ประเภท">{{ row.leaveType }}</td>
              <td data-label="เริ่ม">{{ row.startDate }}</td>
              <td data-label="สิ้นสุด">{{ row.endDate }}</td>
              <td data-label="สถานะ"><StatusChip :label="leaveStatusLabel(row.status)" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </AsyncState>
  </section>
</template>
