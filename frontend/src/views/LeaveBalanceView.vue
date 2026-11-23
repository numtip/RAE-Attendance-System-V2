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

// Share of the entitlement already used (approved days only); only meaningful when the balance is available.
function usedPercent(row: LeaveBalanceRow): number {
  return row.available && row.totalDays && row.usedDays !== null
    ? Math.min(100, Math.max(0, Math.round((row.usedDays / row.totalDays) * 100)))
    : 0;
}
function days(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function reason(row: LeaveBalanceRow): string {
  return row.unavailableReason === 'deductions_not_tracked'
    ? 'ยังไม่มีข้อมูลการหักวันลาสำหรับประเภทนี้'
    : 'ยังไม่มีข้อมูลสิทธิ์วันลาที่ตรวจสอบแล้ว';
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="การลา" title="วันลาคงเหลือ" subtitle="คำนวณจากสิทธิ์วันลาที่ตรวจสอบแล้ว หักด้วยวันลาที่อนุมัติแล้วเท่านั้น — ไม่มีข้อมูลสิทธิ์จะแสดงว่า ไม่มีข้อมูล (ไม่ใช่ 0)" />
    <form class="period" @submit.prevent="load">
      <YearSelect v-model="year" />
      <button type="submit" class="btn btn--primary" :disabled="loading">{{ loading ? 'กำลังโหลด…' : 'แสดงข้อมูล' }}</button>
    </form>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="ไม่มีข้อมูลวันลา"
    >
      <ul v-if="rows.length" class="balance-grid">
        <li v-for="row in rows" :key="`${row.leaveType}-${row.year}`" class="balance">
          <p class="balance-type">{{ row.typeLabel ?? leaveTypeLabel(row.leaveType) }}</p>
          <template v-if="row.available">
            <p class="balance-left"><strong>{{ days(row.remainingDays) }}</strong> <span>วันคงเหลือ</span></p>
            <div class="meter" aria-hidden="true"><span class="meter-fill" :style="{ width: `${usedPercent(row)}%` }"></span></div>
            <p class="muted">ใช้ไป {{ days(row.usedDays) }} จาก {{ days(row.totalDays) }} วัน (อนุมัติแล้ว)</p>
          </template>
          <template v-else>
            <p class="balance-left"><strong>ไม่มีข้อมูล</strong></p>
            <p class="muted">{{ reason(row) }}</p>
            <p v-if="row.usedDays !== null" class="muted">ลาที่อนุมัติแล้วในปีนี้ {{ days(row.usedDays) }} วัน</p>
          </template>
          <p v-if="row.pendingDays" class="muted">รออนุมัติ {{ days(row.pendingDays) }} วัน (ยังไม่หักวันลา)</p>
        </li>
      </ul>
    </AsyncState>
  </section>
</template>
