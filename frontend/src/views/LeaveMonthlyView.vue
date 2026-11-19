<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { LeaveKind, LeaveMonthlyReport } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import KpiTile from '../components/KpiTile.vue';
import PeriodPicker from '../components/PeriodPicker.vue';
import StatusChip from '../components/StatusChip.vue';

const now = new Date();
const year = ref(now.getUTCFullYear());
const month = ref(now.getUTCMonth() + 1);
const loading = ref(false);
const error = ref<string | null>(null);
const report = ref<LeaveMonthlyReport | null>(null);
const query = ref('');
const open = ref<string | null>(null);

const kinds = computed<LeaveKind[]>(() => (report.value?.types ?? []).map((t) => t.type));
const visibleRows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return (report.value?.rows ?? []).filter((row) => !needle
    || row.employeeId.toLowerCase().includes(needle) || row.employeeName.toLowerCase().includes(needle));
});

function cell(row: NonNullable<typeof report.value>['rows'][number], kind: LeaveKind): string {
  if (!row.byType) return '—';
  const b = row.byType[kind];
  return b.requests === 0 ? '0' : `${b.days} วัน (${b.requests} ครั้ง)`;
}

async function load() {
  loading.value = true;
  error.value = null;
  report.value = null;
  open.value = null;
  try {
    report.value = await api.leaveMonthlyReport(year.value, month.value);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'ไม่สามารถโหลดสรุปการลาได้';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="page-head">
      <h2>สรุปการลารายเดือน</h2>
    </div>
    <PeriodPicker v-model:year="year" v-model:month="month" :loading="loading" @submit="load" />
    <AsyncState :loading="loading" :error="error" :empty="false">
      <template v-if="report">
        <h3 class="section-title">
          {{ report.scope === 'organization' ? 'ทั้งองค์กร' : report.scope === 'team' ? 'ทีมของท่าน' : 'ของฉัน' }}
          <span class="muted">· {{ report.periodLabel }}</span>
        </h3>
        <p v-if="!report.coverage.hasLeaveData" class="callout" role="status">{{ report.coverage.note }}</p>
        <p v-else class="callout" role="note">{{ report.notices.dayCounting }}</p>

        <dl v-if="report.totals" class="kpi-grid">
          <KpiTile
            v-for="t in report.types"
            :key="t.type"
            :label="t.labelTh"
            :value="`${report.totals.byType[t.type].days} วัน`"
            :hint="`${report.totals.byType[t.type].requests} ครั้ง (อนุมัติแล้ว)`"
          />
          <KpiTile label="รออนุมัติ" :value="report.totals.pendingRequests" hint="ครั้ง — ยังไม่รวมในยอด" tone="info" />
          <KpiTile label="ไม่อนุมัติ" :value="report.totals.rejectedRequests" hint="ครั้ง — ไม่รวมในยอด" tone="info" />
        </dl>
        <p v-if="report.coverage.unmatchedRecordsExcluded" class="muted">
          มี {{ report.coverage.unmatchedRecordsExcluded }} รายการที่ยังจับคู่พนักงานไม่ได้ จึงไม่นับรวม
        </p>

        <div v-if="report.rows.length > 1" class="toolbar">
          <input v-model="query" class="search" type="search" placeholder="ค้นหาชื่อหรือรหัสพนักงาน" aria-label="ค้นหาชื่อหรือรหัสพนักงาน" />
          <span class="muted" aria-live="polite">แสดง {{ visibleRows.length }} จาก {{ report.rows.length }} คน</span>
        </div>
        <p v-if="visibleRows.length === 0" class="state state--empty">ไม่พบรายการที่ตรงกับเงื่อนไข</p>
        <div v-else class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th class="sticky-col">พนักงาน</th>
                <th v-for="t in report.types" :key="t.type">{{ t.labelTh }}</th>
                <th class="num">รออนุมัติ</th>
                <th><span class="sr-only">รายละเอียด</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in visibleRows" :key="row.employeeId">
                <tr>
                  <td class="sticky-col">
                    <strong>{{ row.employeeName }}</strong><br />
                    <span class="muted">{{ row.employeeId }}</span>
                  </td>
                  <td v-for="k in kinds" :key="k" :class="{ muted: !row.byType }">{{ cell(row, k) }}</td>
                  <td class="num" :class="{ muted: row.pendingRequests === null }">{{ row.pendingRequests ?? '—' }}</td>
                  <td>
                    <button
                      v-if="row.details.length"
                      type="button"
                      class="btn btn--ghost"
                      :aria-expanded="open === row.employeeId"
                      @click="open = open === row.employeeId ? null : row.employeeId"
                    >{{ open === row.employeeId ? 'ซ่อน' : 'รายละเอียด' }}</button>
                  </td>
                </tr>
                <tr v-if="open === row.employeeId">
                  <td :colspan="kinds.length + 3">
                    <ul class="plain-list">
                      <li v-for="(d, i) in row.details" :key="i">
                        {{ d.typeLabel }} · {{ d.startLabel }}<template v-if="d.startLabel !== d.endLabel"> – {{ d.endLabel }}</template>
                        · <StatusChip :label="d.statusLabel" />
                        <span class="muted">
                          · {{ d.daysInMonth }} วันในเดือนนี้<template v-if="d.crossesMonth"> (ลาคาบเกี่ยวเดือน)</template>
                          <template v-if="!d.counted"> · ไม่รวมในยอด</template>
                        </span>
                      </li>
                    </ul>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p v-if="!report.coverage.hasLeaveData" class="muted">เครื่องหมาย — หมายถึงไม่มีข้อมูล ไม่ใช่ศูนย์วัน</p>
      </template>
    </AsyncState>
  </section>
</template>
