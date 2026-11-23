<script setup lang="ts">
import { errorMessageTh } from '../utils/i18n';
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { LeaveRow } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import LeaveRecordsTable from '../components/LeaveRecordsTable.vue';
import PageHeader from '../components/PageHeader.vue';
import YearSelect from '../components/YearSelect.vue';

const year = ref(new Date().getUTCFullYear());
const loading = ref(true);
const error = ref<string | null>(null);
const rows = ref<LeaveRow[]>([]);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.leaveList(undefined, year.value);
  } catch (e) {
    rows.value = [];
    error.value = errorMessageTh(e, 'ไม่สามารถโหลดรายการลาได้');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="การลา" title="รายการลา" subtitle="รายการลาของท่านที่บันทึกในระบบ (รายงาน HIP และบันทึกด้วยมือ) พร้อมสถานะการอนุมัติจริง">
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">โหลดใหม่</button>
    </PageHeader>
    <form class="period" @submit.prevent="load">
      <YearSelect v-model="year" />
      <button type="submit" class="btn btn--primary" :disabled="loading">{{ loading ? 'กำลังโหลด…' : 'แสดงข้อมูล' }}</button>
    </form>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="ไม่พบรายการลาในปีที่เลือก"
    >
      <template v-if="rows.length">
        <p class="muted">{{ rows.length }} รายการ — รายการที่ยังไม่แสดงสถานะ "อนุมัติแล้ว" คือยังไม่ผ่านการอนุมัติ และไม่ใช้หักวันลาคงเหลือ</p>
        <LeaveRecordsTable :rows="rows" />
      </template>
    </AsyncState>
  </section>
</template>
