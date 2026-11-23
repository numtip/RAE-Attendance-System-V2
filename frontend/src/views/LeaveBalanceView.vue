<script setup lang="ts">
import YearSelect from '../components/YearSelect.vue';
import { errorMessageTh, leaveTypeLabel } from '../utils/i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client';
import { ApiError } from '../api/errors';
import type { LeaveBalanceRow } from '../api/types';
import {
  DEFAULT_FISCAL_YEAR_BE, fiscalRangeTh, fiscalYearOptions, formatDays, reasonsTh, statusLabelTh, uncoveredMonthsTh, usedDaysDisplay,
  usedPercent as fiscalUsedPercent,
  type BalanceBasis,
} from '../utils/leaveEntitlement';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';
import PageHeader from '../components/PageHeader.vue';

const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');
const year = ref(new Date().getUTCFullYear());
// Calendar year stays the default (the long-standing behaviour); the fiscal basis is opt-in and opens on FY2570.
const basis = ref<BalanceBasis>('calendar');
const fiscalYear = ref(DEFAULT_FISCAL_YEAR_BE);
const engineOff = ref(false);
const isFiscal = computed(() => basis.value === 'fiscal');

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
  engineOff.value = false;
  try {
    // One request per load: the API returns every leave type at once.
    rows.value = isFiscal.value
      ? await api.leaveBalance(employeeUid.value, fiscalYear.value, 'fiscal')
      : await api.leaveBalance(employeeUid.value, year.value);
  } catch (e) {
    rows.value = [];
    if (e instanceof ApiError && e.code === 'LEAVE_ENTITLEMENT_ENGINE_OFF') engineOff.value = true;
    else error.value = errorMessageTh(e, 'ไม่สามารถโหลดวันลาคงเหลือได้');
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
const days = formatDays;
const fiscalPercent = fiscalUsedPercent;
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
      <label class="field">
        <span>เกณฑ์การนับ</span>
        <select v-model="basis" @change="rows = []; engineOff = false">
          <option value="calendar">ปีปฏิทิน</option>
          <option value="fiscal">ปีงบประมาณ (1 ต.ค. – 30 ก.ย.)</option>
        </select>
      </label>
      <label v-if="isFiscal" class="field">
        <span>ปีงบประมาณ (พ.ศ.)</span>
        <select v-model.number="fiscalYear">
          <option v-for="y in fiscalYearOptions()" :key="y" :value="y">{{ y }}</option>
        </select>
      </label>
      <YearSelect v-else v-model="year" />
      <button type="submit" class="btn btn--primary" :disabled="loading">{{ loading ? 'กำลังโหลด…' : 'แสดงข้อมูล' }}</button>
    </form>
    <p v-if="engineOff" class="muted" role="status">ระบบคำนวณสิทธิ์วันลาตามปีงบประมาณยังไม่เปิดใช้งาน — เลือกเกณฑ์ “ปีปฏิทิน” เพื่อดูวันลาคงเหลือตามเดิม</p>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && !engineOff && rows.length === 0"
      empty-message="ไม่มีข้อมูลวันลา"
    >
      <p v-if="isFiscal && rows.length" class="muted">ปีงบประมาณ {{ fiscalYear }}: {{ fiscalRangeTh(rows[0]) }}</p>
      <ul v-if="rows.length && isFiscal" class="balance-grid">
        <li v-for="row in rows" :key="`fy-${row.leaveType}-${row.year}`" class="balance">
          <p class="balance-type">{{ row.typeLabel ?? leaveTypeLabel(row.leaveType) }} <span class="muted">· {{ statusLabelTh(row.status) }}</span></p>
          <template v-if="row.available">
            <p class="balance-left"><strong>{{ days(row.remainingDays) }}</strong> <span>วันคงเหลือ</span></p>
            <div v-if="fiscalPercent(row) !== null" class="meter" aria-hidden="true"><span class="meter-fill" :style="{ width: `${fiscalPercent(row)}%` }"></span></div>
          </template>
          <p v-else class="balance-left"><strong>ไม่มีข้อมูล</strong></p>
          <dl class="muted">
            <div><dt>สิทธิ์ปีนี้</dt><dd>{{ days(row.entitlementDays) }} วัน</dd></div>
            <div><dt>ยกยอดมา</dt><dd>{{ row.leaveType === 'vacation' ? `${days(row.carryoverDays)} วัน` : '—' }}</dd></div>
            <div><dt>ใช้ไป (อนุมัติแล้ว)</dt><dd>{{ days(usedDaysDisplay(row)) }} วัน</dd></div>
          </dl>
          <p v-for="text in reasonsTh(row)" :key="text" class="muted">{{ text }}</p>
          <p v-if="uncoveredMonthsTh(row)" class="muted">เดือนที่ยังไม่มีข้อมูลการลา: {{ uncoveredMonthsTh(row) }}</p>
          <p v-if="row.pendingDays" class="muted">รออนุมัติ {{ days(row.pendingDays) }} วัน (ยังไม่หักวันลา)</p>
        </li>
      </ul>
      <ul v-else-if="rows.length" class="balance-grid">
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
