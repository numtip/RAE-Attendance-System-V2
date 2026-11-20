<script setup lang="ts">
import YearSelect from '../components/YearSelect.vue';
import { errorMessageTh, leaveTypeLabel } from '../utils/i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { LeaveBalanceRow } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';
import PageHeader from '../components/PageHeader.vue';

const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');
const year = ref(new Date().getUTCFullYear());

const loading = ref(false);
const error = ref<string | null>(null);
const rows = ref<LeaveBalanceRow[]>([]);

async function load() {
  if (!employeeUid.value) {
    error.value = 'ไม่พบข้อมูลผู้ใช้ กรุณาเข้าสู่ระบบใหม่';
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.leaveBalance(employeeUid.value, year.value);
  } catch (e) {
    rows.value = [];
    error.value = errorMessageTh(e, 'ไม่สามารถโหลดวันลาคงเหลือได้');
  } finally {
    loading.value = false;
  }
}

// Share of the entitlement already used, derived only from the API figures; 0 when no total is recorded.
function usedPercent(row: LeaveBalanceRow): number {
  return row.totalDays > 0 ? Math.min(100, Math.max(0, Math.round((row.usedDays / row.totalDays) * 100))) : 0;
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="การลา" title="วันลาคงเหลือ" subtitle="แสดงตามที่บันทึกในระบบเท่านั้น — ระบบไม่คำนวณหรือหักวันลาเอง" />
    <form class="period" @submit.prevent="load">
      <YearSelect v-model="year" />
      <button type="submit" class="btn btn--primary" :disabled="loading">{{ loading ? 'กำลังโหลด…' : 'แสดงข้อมูล' }}</button>
    </form>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="ไม่มีวันลาคงเหลือที่บันทึกไว้"
    >
      <ul v-if="rows.length" class="balance-grid">
        <li v-for="row in rows" :key="`${row.leaveType}-${row.year}`" class="balance">
          <p class="balance-type">{{ leaveTypeLabel(row.leaveType) }}</p>
          <p class="balance-left"><strong>{{ row.remainingDays }}</strong> <span>วันคงเหลือ</span></p>
          <div class="meter" aria-hidden="true"><span class="meter-fill" :style="{ width: `${usedPercent(row)}%` }"></span></div>
          <p class="muted">ใช้ไป {{ row.usedDays }} จาก {{ row.totalDays }} วัน</p>
        </li>
      </ul>
    </AsyncState>
  </section>
</template>
