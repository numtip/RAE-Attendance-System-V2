<script setup lang="ts">
import { errorMessageTh } from '../utils/i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { LeaveRow } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';
import PageHeader from '../components/PageHeader.vue';
import LeaveRecordsTable from '../components/LeaveRecordsTable.vue';

const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');

const loading = ref(true);
const error = ref<string | null>(null);
const rows = ref<LeaveRow[]>([]);
// Rows arrive newest first; group them by the calendar year of the start date.
const groups = computed(() => {
  const byYear = new Map<number, LeaveRow[]>();
  for (const row of rows.value) {
    const year = Number(row.startDate.slice(0, 4));
    byYear.set(year, [...(byYear.get(year) ?? []), row]);
  }
  return [...byYear].map(([year, list]) => ({ year, rows: list }));
});

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
    error.value = errorMessageTh(e, 'ไม่สามารถโหลดประวัติการลาได้');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="การลา" title="ประวัติการลา" subtitle="ประวัติการลาย้อนหลังทุกปีของท่าน (รายงาน HIP, บันทึกด้วยมือ และระบบเดิม) พร้อมสถานะการอนุมัติจริง">
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">โหลดใหม่</button>
    </PageHeader>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="ไม่มีประวัติการลา"
    >
      <template v-for="group in groups" :key="group.year">
        <h3 class="section-title">ปี พ.ศ. {{ group.year + 543 }} <span class="muted">· {{ group.rows.length }} รายการ</span></h3>
        <LeaveRecordsTable :rows="group.rows" />
      </template>
    </AsyncState>
  </section>
</template>
