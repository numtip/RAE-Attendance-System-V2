<script setup lang="ts">
import { errorMessageTh } from '../utils/i18n';
import { computed, onMounted, ref } from 'vue';
import { api, downloadLeaveMonthly } from '../api/client';
import type { LeaveKind, LeaveMonthlyReport, LeaveMonthlyRow, LeaveRecordStatus, LeaveReportQuery } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import KpiTile from '../components/KpiTile.vue';
import PageHeader from '../components/PageHeader.vue';
import ThaiDateInput from '../components/ThaiDateInput.vue';
import YearSelect from '../components/YearSelect.vue';
import { THAI_MONTHS } from '../utils/thai';

const now = new Date();
const year = ref(now.getUTCFullYear());
const month = ref<number>(now.getUTCMonth() + 1); // 0 = whole year
const useRange = ref(false);
const from = ref(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`);
const to = ref(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10));
const division = ref('');
const employeeUid = ref('');
const type = ref<LeaveKind | ''>('');
const status = ref<LeaveRecordStatus | ''>('');
const loading = ref(false);
const error = ref<string | null>(null);
const exportError = ref<string | null>(null);
const report = ref<LeaveMonthlyReport | null>(null);
const roster = ref<{ uid: string; label: string }[]>([]);
const query = ref('');
const open = ref<string | null>(null);

const kinds = computed<LeaveKind[]>(() => (report.value?.types ?? []).map((t) => t.type));
const visibleRows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return (report.value?.rows ?? []).filter((row) => (
    !needle || row.employeeId.toLowerCase().includes(needle) || row.employeeName.toLowerCase().includes(needle)
  ));
});
const showDivisions = computed(() => report.value?.scope !== 'self' && (report.value?.byDivision?.length ?? 0) > 0);

function currentQuery(): LeaveReportQuery {
  return {
    year: year.value,
    month: month.value || null,
    from: useRange.value ? from.value : undefined,
    to: useRange.value ? to.value : undefined,
    division: division.value,
    employeeUid: employeeUid.value,
    type: type.value,
    status: status.value,
  };
}

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
function statusChip(code: LeaveRecordStatus): string {
  if (code === 'approved') return 'chip chip--ok';
  if (code === 'needs_review') return 'chip chip--late';
  if (code === 'rejected') return 'chip chip--muted';
  return 'chip chip--leave';
}

async function load() {
  loading.value = true;
  error.value = null;
  exportError.value = null;
  report.value = null;
  open.value = null;
  try {
    const result = await api.leaveMonthlyReport(currentQuery());
    report.value = result;
    // The employee picker lists everyone the current division/scope allows (not just the picked person).
    if (!employeeUid.value) {
      roster.value = result.rows.map((row) => ({ uid: row.employeeUid, label: `${row.employeeId} · ${row.employeeName}` }));
    }
  } catch (e) {
    error.value = errorMessageTh(e, 'ไม่สามารถโหลดสรุปการลาได้');
  } finally {
    loading.value = false;
  }
}

function onDivisionChange() {
  employeeUid.value = ''; // the picked person may not belong to the new division
  void load();
}

function reset() {
  month.value = now.getUTCMonth() + 1;
  year.value = now.getUTCFullYear();
  useRange.value = false;
  division.value = '';
  employeeUid.value = '';
  type.value = '';
  status.value = '';
  query.value = '';
  void load();
}

async function download(format: 'pdf' | 'xlsx') {
  exportError.value = null;
  try {
    await downloadLeaveMonthly(currentQuery(), format);
  } catch (e) {
    exportError.value = errorMessageTh(e, 'ส่งออกรายงานไม่สำเร็จ');
  }
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="การลา" title="รายงานการลา" subtitle="ข้อมูลการลาที่บันทึกจากรายงาน HIP แยกสถานะ บันทึก / รออนุมัติ / รอตรวจสอบ / อนุมัติแล้ว อย่างชัดเจน">
      <button type="button" class="btn" :disabled="loading || !report" @click="download('pdf')">ส่งออก PDF</button>
      <button type="button" class="btn" :disabled="loading || !report" @click="download('xlsx')">ส่งออก Excel</button>
    </PageHeader>

    <form class="period" @submit.prevent="load">
      <label class="field">
        <span>เดือน</span>
        <select v-model.number="month" :disabled="useRange">
          <option :value="0">ทั้งปี</option>
          <option v-for="(name, index) in THAI_MONTHS" :key="name" :value="index + 1">{{ name }}</option>
        </select>
      </label>
      <YearSelect v-model="year" />
      <label class="field">
        <span>กอง</span>
        <select v-model="division" @change="onDivisionChange">
          <option value="">ทุกกอง</option>
          <option v-for="d in report?.divisions ?? []" :key="d.code" :value="d.code">{{ d.nameTh }}</option>
        </select>
      </label>
      <label v-if="report?.scope !== 'self'" class="field">
        <span>พนักงาน</span>
        <select v-model="employeeUid">
          <option value="">ทุกคน</option>
          <option v-for="r in roster" :key="r.uid" :value="r.uid">{{ r.label }}</option>
        </select>
      </label>
      <label class="field">
        <span>ประเภทการลา</span>
        <select v-model="type">
          <option value="">ทุกประเภท</option>
          <option v-for="t in report?.types ?? []" :key="t.type" :value="t.type">{{ t.labelTh }}</option>
        </select>
      </label>
      <label class="field">
        <span>สถานะ</span>
        <select v-model="status">
          <option value="">ทุกสถานะ</option>
          <option v-for="st in report?.statuses ?? []" :key="st.code" :value="st.code">{{ st.label }}</option>
        </select>
      </label>
      <label class="field field--inline">
        <input v-model="useRange" type="checkbox" />
        <span>ระบุช่วงวันที่</span>
      </label>
      <template v-if="useRange">
        <ThaiDateInput v-model="from" label="ตั้งแต่วันที่" />
        <ThaiDateInput v-model="to" label="ถึงวันที่" />
      </template>
      <button type="submit" class="btn btn--primary" :disabled="loading">{{ loading ? 'กำลังโหลด…' : 'แสดงรายงาน' }}</button>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="reset">ล้างตัวกรอง</button>
    </form>

    <p v-if="exportError" class="form-error" role="alert">{{ exportError }}</p>
    <AsyncState :loading="loading" :error="error" :empty="false">
      <template v-if="report">
        <h3 class="section-title">
          {{ report.scope === 'organization' ? 'ทั้งองค์กร' : report.scope === 'team' ? 'ทีมของท่าน' : 'ของฉัน' }}
          <span class="muted">· {{ report.periodLabel }}</span>
        </h3>

        <p v-if="report.dataThrough?.partial" class="callout" role="alert">{{ report.dataThrough.note }}</p>
        <p v-else-if="report.dataThrough?.label" class="muted">{{ report.dataThrough.label }}</p>
        <p v-if="report.recordedCoverage.note" class="callout" role="status">{{ report.recordedCoverage.note }}</p>
        <p v-if="report.recordedTotals" class="callout" role="note">{{ report.notices.recorded }}</p>

        <template v-if="report.recordedTotals">
          <h4 class="section-title">สรุปตามสถานะ</h4>
          <dl class="kpi-grid">
            <KpiTile label="บันทึกจาก HIP (รวม)" :value="`${days(report.recordedTotals.all.recordedDays)} วัน`" :hint="`${report.recordedTotals.all.records - report.recordedTotals.all.needsReviewRecords - report.recordedTotals.all.rejectedRecords} รายการ`" />
            <KpiTile label="อนุมัติแล้ว" :value="`${days(report.recordedTotals.all.approvedDays)} วัน`" hint="ผู้บริหารอนุมัติแล้ว" />
            <KpiTile label="รออนุมัติ" :value="`${days(report.recordedTotals.all.awaitingApprovalDays)} วัน`" hint="บันทึกแล้ว ยังไม่ผ่านการอนุมัติ" tone="leave" />
            <KpiTile label="รอตรวจสอบ" :value="report.recordedTotals.all.needsReviewRecords" hint="รายการ — ไม่รวมในยอดวัน" tone="info" />
            <KpiTile v-if="report.recordedTotals.all.rejectedRecords" label="ไม่อนุมัติ" :value="report.recordedTotals.all.rejectedRecords" hint="รายการ — ไม่รวมในยอดวัน" />
          </dl>

          <h4 class="section-title">สรุปตามประเภทการลา</h4>
          <dl class="kpi-grid">
            <KpiTile
              v-for="t in report.types"
              :key="t.type"
              :label="t.labelTh"
              :value="`${days(report.recordedTotals.byType[t.type].days)} วัน`"
              :hint="`เต็มวัน ${report.recordedTotals.byType[t.type].fullDays} · ครึ่งวัน ${report.recordedTotals.byType[t.type].halfDays} · อนุมัติแล้ว ${days(report.recordedTotals.byType[t.type].approvedDays)} · รออนุมัติ ${days(report.recordedTotals.byType[t.type].awaitingApprovalDays)} วัน`"
            />
          </dl>
        </template>

        <p v-if="!report.coverage.hasLeaveData" class="muted">ลาที่อนุมัติอย่างเป็นทางการ (ระบบเดิม): ยังไม่มีข้อมูลในระบบ</p>
        <dl v-else-if="report.totals" class="kpi-grid">
          <KpiTile
            v-for="t in report.types"
            :key="`o-${t.type}`"
            :label="`${t.labelTh} (อนุมัติทางการ)`"
            :value="`${report.totals.byType[t.type].days} วัน`"
            :hint="`${report.totals.byType[t.type].requests} ครั้ง`"
          />
        </dl>

        <template v-if="showDivisions && report.byDivision">
          <h4 class="section-title">สรุปรายกอง</h4>
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>กอง</th><th class="num">คน</th>
                  <th v-for="t in report.types" :key="t.type" class="num">{{ t.labelTh }}</th>
                  <th class="num">รวม (วัน)</th><th class="num">อนุมัติแล้ว</th><th class="num">รออนุมัติ</th><th class="num">รอตรวจสอบ</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in report.byDivision" :key="d.code">
                  <td>{{ d.nameTh }}</td>
                  <td class="num">{{ d.headcount }}</td>
                  <td v-for="t in report.types" :key="t.type" class="num">{{ days(d.byType[t.type].days) }}</td>
                  <td class="num"><strong>{{ days(d.recordedDays) }}</strong></td>
                  <td class="num">{{ days(d.approvedDays) }}</td>
                  <td class="num">{{ days(d.awaitingApprovalDays) }}</td>
                  <td class="num">{{ d.needsReviewRecords }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <h4 class="section-title">สรุปรายบุคคล</h4>
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
                <th class="num">รวม (วัน)</th>
                <th class="num">อนุมัติแล้ว</th>
                <th class="num">รอตรวจสอบ</th>
                <th><span class="sr-only">รายละเอียด</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in visibleRows" :key="row.employeeId">
                <tr>
                  <td class="sticky-col">
                    <strong>{{ row.employeeName }}</strong><br />
                    <span class="muted">{{ row.employeeId }} · {{ row.divisionName }}</span>
                  </td>
                  <td v-for="k in kinds" :key="k" :class="{ muted: !row.recorded }">{{ cell(row, k) }}</td>
                  <td class="num" :class="{ muted: !row.recordedTotals }">{{ row.recordedTotals ? days(row.recordedTotals.recordedDays) : '—' }}</td>
                  <td class="num" :class="{ muted: !row.recordedTotals }">{{ row.recordedTotals ? days(row.recordedTotals.approvedDays) : '—' }}</td>
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
                  <td :colspan="kinds.length + 5">
                    <div class="detail-box">
                      <ul class="plain-list">
                        <li v-for="(d, i) in row.recordedDetails" :key="i">
                          {{ d.typeLabel }} · {{ d.dateLabel }} · {{ d.partLabel }}
                          <template v-if="d.dayFraction !== null"> · {{ days(d.dayFraction) }} วัน</template>
                          <span v-if="d.status" :class="statusChip(d.status)">{{ d.statusLabel }}</span>
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

        <template v-if="report.records.length">
          <h4 class="section-title">รายการลาโดยละเอียด <span class="muted">· {{ report.records.length }} รายการ</span></h4>
          <div class="table-scroll">
            <table class="data-table data-table--stack">
              <thead>
                <tr><th>วันที่</th><th>พนักงาน</th><th>กอง</th><th>ประเภท</th><th>ช่วงเวลา</th><th class="num">จำนวนวัน</th><th>สถานะ</th></tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in report.records" :key="`${r.employeeUid}-${r.date}-${r.dayPart}-${i}`">
                  <td data-label="วันที่">{{ r.dateLabel }}</td>
                  <td data-label="พนักงาน"><strong>{{ r.employeeName }}</strong> <span class="muted">{{ r.employeeId }}</span></td>
                  <td data-label="กอง">{{ r.divisionName }}</td>
                  <td data-label="ประเภท">{{ r.typeLabel }}</td>
                  <td data-label="ช่วงเวลา">{{ r.partLabel }}</td>
                  <td data-label="จำนวนวัน" class="num">{{ r.dayFraction === null ? '—' : days(r.dayFraction) }}</td>
                  <td data-label="สถานะ">
                    <span :class="statusChip(r.status)">{{ r.statusLabel }}</span>
                    <span v-if="r.reasonLabels.length" class="muted"> {{ r.reasonLabels.join('; ') }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <p v-else-if="report.recordedTotals" class="state state--empty">ไม่พบรายการลาที่ตรงกับตัวกรอง</p>

        <p v-if="report.recordedTotals" class="muted">
          {{ report.reconciliation.reconciled ? 'ตรวจสอบยอดแล้ว' : 'ยอดไม่ตรงกัน — โปรดแจ้งผู้ดูแลระบบ' }}:
          {{ report.reconciliation.recordsMatched }} รายการ = ผลรวมรายบุคคล = ผลรวมรายกอง = รายการโดยละเอียด
        </p>
        <p v-if="report.recordedTotals" class="muted">{{ report.notices.recordedCounting }}</p>
        <p v-if="report.coverage.hasLeaveData" class="muted">{{ report.notices.dayCounting }}</p>
      </template>
    </AsyncState>
  </section>
</template>
