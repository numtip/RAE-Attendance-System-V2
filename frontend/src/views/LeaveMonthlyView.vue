<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api, downloadLeaveMonthly } from '../api/client';
import type { LeaveKind, LeaveMonthlyReport, LeaveMonthlyRow } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import KpiTile from '../components/KpiTile.vue';
import PeriodPicker from '../components/PeriodPicker.vue';

const now = new Date();
const year = ref(now.getUTCFullYear());
const month = ref(now.getUTCMonth() + 1);
const loading = ref(false);
const error = ref<string | null>(null);
const exportError = ref<string | null>(null);
const report = ref<LeaveMonthlyReport | null>(null);
const query = ref('');
const onlyReview = ref(false);
const open = ref<string | null>(null);

const kinds = computed<LeaveKind[]>(() => (report.value?.types ?? []).map((t) => t.type));
const visibleRows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return (report.value?.rows ?? []).filter((row) => (
    (!onlyReview.value || (row.recordedNeedsReview ?? 0) > 0)
    && (!needle || row.employeeId.toLowerCase().includes(needle) || row.employeeName.toLowerCase().includes(needle))
  ));
});

function days(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function cell(row: LeaveMonthlyRow, kind: LeaveKind): string {
  if (!row.recorded) return '—';
  const b = row.recorded[kind];
  if (b.records === 0) return '0';
  const half = b.halfDays ? ` (ครึ่งวัน ${b.halfDays})` : '';
  return `${days(b.days)} วัน${half}`;
}

async function load() {
  loading.value = true;
  error.value = null;
  exportError.value = null;
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

async function download(format: 'pdf' | 'xlsx') {
  exportError.value = null;
  try {
    await downloadLeaveMonthly(year.value, month.value, format);
  } catch (e) {
    exportError.value = e instanceof ApiError ? e.message : 'ส่งออกรายงานไม่สำเร็จ';
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="page-head">
      <h2>สรุปการลารายเดือน</h2>
      <div class="actions">
        <button type="button" class="btn" :disabled="loading || !report" @click="download('pdf')">ส่งออก PDF</button>
        <button type="button" class="btn" :disabled="loading || !report" @click="download('xlsx')">ส่งออก Excel</button>
      </div>
    </div>
    <PeriodPicker v-model:year="year" v-model:month="month" :loading="loading" @submit="load" />
    <p v-if="exportError" class="form-error" role="alert">{{ exportError }}</p>
    <AsyncState :loading="loading" :error="error" :empty="false">
      <template v-if="report">
        <h3 class="section-title">
          {{ report.scope === 'organization' ? 'ทั้งองค์กร' : report.scope === 'team' ? 'ทีมของท่าน' : 'ของฉัน' }}
          <span class="muted">· {{ report.periodLabel }}</span>
        </h3>

        <p v-if="!report.recordedCoverage.periodCovered" class="callout" role="status">{{ report.recordedCoverage.note }}</p>
        <p v-else class="callout" role="note">{{ report.notices.recorded }}</p>

        <dl v-if="report.recordedTotals" class="kpi-grid">
          <KpiTile
            v-for="t in report.types"
            :key="t.type"
            :label="t.labelTh"
            :value="`${days(report.recordedTotals.byType[t.type].days)} วัน`"
            :hint="`เต็มวัน ${report.recordedTotals.byType[t.type].fullDays} · ครึ่งวัน ${report.recordedTotals.byType[t.type].halfDays}`"
          />
          <KpiTile label="รอตรวจสอบ" :value="report.recordedTotals.needsReviewRecords" hint="รายการ — ไม่รวมในยอด" tone="info" />
        </dl>
        <p v-if="report.recordedTotals" class="muted">ยอดข้างต้นคือข้อมูลที่บันทึกจากรายงาน HIP — ยังไม่ใช่ข้อมูลที่ผ่านการอนุมัติ</p>

        <p v-if="!report.coverage.hasLeaveData" class="muted">ลาที่อนุมัติอย่างเป็นทางการ: ยังไม่มีข้อมูลในระบบ</p>
        <dl v-else-if="report.totals" class="kpi-grid">
          <KpiTile
            v-for="t in report.types"
            :key="`o-${t.type}`"
            :label="`${t.labelTh} (อนุมัติทางการ)`"
            :value="`${report.totals.byType[t.type].days} วัน`"
            :hint="`${report.totals.byType[t.type].requests} ครั้ง`"
          />
        </dl>

        <div v-if="report.rows.length > 1" class="toolbar">
          <input v-model="query" class="search" type="search" placeholder="ค้นหาชื่อหรือรหัสพนักงาน" aria-label="ค้นหาชื่อหรือรหัสพนักงาน" />
          <label>
            <input v-model="onlyReview" type="checkbox" />
            เฉพาะผู้ที่มีรายการรอตรวจสอบ
          </label>
          <span class="muted" aria-live="polite">แสดง {{ visibleRows.length }} จาก {{ report.rows.length }} คน</span>
        </div>
        <p v-if="visibleRows.length === 0" class="state state--empty">ไม่พบรายการที่ตรงกับเงื่อนไข</p>
        <div v-else class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th class="sticky-col">พนักงาน</th>
                <th v-for="t in report.types" :key="t.type">{{ t.labelTh }}</th>
                <th class="num">รอตรวจสอบ</th>
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
                  <td v-for="k in kinds" :key="k" :class="{ muted: !row.recorded }">{{ cell(row, k) }}</td>
                  <td class="num" :class="{ muted: row.recordedNeedsReview === null }">{{ row.recordedNeedsReview ?? '—' }}</td>
                  <td>
                    <button
                      v-if="row.recordedDetails.length"
                      type="button"
                      class="btn btn--ghost"
                      :aria-expanded="open === row.employeeId"
                      @click="open = open === row.employeeId ? null : row.employeeId"
                    >{{ open === row.employeeId ? 'ซ่อน' : 'รายละเอียด' }}</button>
                  </td>
                </tr>
                <tr v-if="open === row.employeeId">
                  <td :colspan="kinds.length + 3">
                    <div class="detail-box">
                    <ul class="plain-list">
                      <li v-for="(d, i) in row.recordedDetails" :key="i">
                        {{ d.typeLabel }} · {{ d.dateLabel }} · {{ d.partLabel }}
                        <template v-if="d.dayFraction !== null"> · {{ days(d.dayFraction) }} วัน</template>
                        <span v-if="d.reviewStatus === 'needs_review'" class="chip chip--late">รอตรวจสอบ</span>
                        <span v-else class="muted"> · บันทึกจาก HIP (ยังไม่ยืนยันอนุมัติ)</span>
                        <span v-if="d.reasonLabels.length" class="muted"> — {{ d.reasonLabels.join('; ') }} (ไม่รวมในยอด)</span>
                      </li>
                    </ul>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p v-if="report.recordedCoverage.periodCovered" class="muted">{{ report.notices.dayCounting }}</p>
      </template>
    </AsyncState>
  </section>
</template>
