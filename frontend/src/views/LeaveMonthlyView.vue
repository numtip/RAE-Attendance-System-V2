<script setup lang="ts">
import { errorMessageTh } from '../utils/i18n';
import { computed, onMounted, ref } from 'vue';
import { api, downloadLeaveMonthly } from '../api/client';
import type { LeaveBalanceRow, LeaveKind, LeaveMonthlyReport, LeaveMonthlyRow, LeaveRecordStatus, LeaveReportQuery } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import KpiTile from '../components/KpiTile.vue';
import PageHeader from '../components/PageHeader.vue';
import ThaiDateInput from '../components/ThaiDateInput.vue';
import YearSelect from '../components/YearSelect.vue';
import { THAI_MONTHS, leaveRecordChipClass } from '../utils/thai';
import { LEAVE_KIND_COLOR, NO_DATA, formatDays, monthlyTrend, personStats, reviewIssues, typeSlices } from '../utils/leaveAnalytics';

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
const TABS = [
  { id: 'overview', label: 'ภาพรวม' },
  { id: 'people', label: 'รายบุคคล' },
  { id: 'divisions', label: 'รายกอง' },
  { id: 'details', label: 'รายละเอียด' },
  { id: 'quality', label: 'ตรวจสอบข้อมูล' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const tab = ref<TabId>('overview');
/** Whole-year report with the same filters, used only for the monthly trend when the view is narrower than a year. */
const yearReport = ref<LeaveMonthlyReport | null>(null);
const balance = ref<LeaveBalanceRow[] | null>(null);
const balanceState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');

const kinds = computed<LeaveKind[]>(() => (report.value?.types ?? []).map((t) => t.type));
const visibleRows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return (report.value?.rows ?? []).filter((row) => (
    !needle || row.employeeId.toLowerCase().includes(needle) || row.employeeName.toLowerCase().includes(needle)
  ));
});
const slices = computed(() => (report.value ? typeSlices(report.value) : []));
const maxSlice = computed(() => Math.max(0, ...slices.value.map((x) => x.days)));
const trendSource = computed(() => (month.value === 0 && !useRange.value ? report.value : yearReport.value));
const trend = computed(() => (trendSource.value ? monthlyTrend(trendSource.value, THAI_MONTHS) : []));
const trendMax = computed(() => Math.max(0, ...trend.value.map((p) => p.days ?? 0)));
const people = computed(() => (report.value ? personStats(report.value) : []));
const peopleMax = computed(() => Math.max(0, ...people.value.map((p) => p.recordedDays ?? 0)));
/** Average recorded days per employee who has counted leave days; null = nobody to average over. */
const avgPerPerson = computed(() => {
  const withDays = (report.value?.rows ?? []).filter((r) => (r.recordedTotals?.recordedDays ?? 0) > 0);
  const total = report.value?.recordedTotals?.all.recordedDays ?? 0;
  return withDays.length ? { avg: total / withDays.length, people: withDays.length } : null;
});
const balanceRows = computed(() => (report.value?.types ?? []).map((t) => {
  const b = balance.value?.find((x) => x.leaveType === t.type);
  return { type: t.type, label: t.labelTh, total: b?.totalDays ?? null, used: b?.usedDays ?? null, remaining: b?.remainingDays ?? null };
}));
const issues = computed(() => (report.value ? reviewIssues(report.value) : []));
const divMax = computed(() => Math.max(0, ...(report.value?.byDivision ?? []).map((d) => d.recordedDays)));
const pct = (value: number, max: number) => (max > 0 ? `${Math.max(0, Math.min(100, (value / max) * 100))}%` : '0%');
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

const days = formatDays;
function cell(row: LeaveMonthlyRow, kind: LeaveKind): string {
  if (!row.recorded) return '—';
  const b = row.recorded[kind];
  if (b.records === 0) return '0';
  const half = b.halfDays ? ` (ครึ่งวัน ${b.halfDays})` : '';
  return `${days(b.days)} วัน${half}`;
}

let loadId = 0;
async function load() {
  loadId += 1;
  loading.value = true;
  error.value = null;
  exportError.value = null;
  report.value = null;
  open.value = null;
  yearReport.value = null;
  balance.value = null;
  balanceState.value = 'idle';
  try {
    const result = await api.leaveMonthlyReport(currentQuery());
    report.value = result;
    void loadTrend(loadId);
    void loadBalance(loadId);
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

/** Trend needs the whole year; degrades to "ไม่มีข้อมูล" on failure. */
async function loadTrend(token: number) {
  yearReport.value = null;
  if (month.value === 0 && !useRange.value) return;
  try {
    const result = await api.leaveMonthlyReport({ ...currentQuery(), month: null, from: undefined, to: undefined });
    if (token === loadId) yearReport.value = result;
  } catch { yearReport.value = null; }
}

/** Entitlement is fetched for ONE selected employee only (never one request per employee). */
async function loadBalance(token: number) {
  balance.value = null;
  balanceState.value = 'idle';
  const uid = employeeUid.value || (report.value?.scope === 'self' ? report.value.rows[0]?.employeeUid : '');
  if (!uid) return;
  balanceState.value = 'loading';
  try {
    const rows = await api.leaveBalance(uid, year.value);
    if (token !== loadId) return;
    balance.value = rows;
    balanceState.value = 'ready';
  } catch {
    if (token === loadId) balanceState.value = 'error';
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
      <label class="range-toggle">
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
          <dl class="kpi-grid kpi-grid--six">
            <KpiTile label="พนักงานในขอบเขต" :value="`${report.rows.length} คน`" :hint="`${report.rows.filter((r) => r.recordedDetails.length).length} คนมีรายการลา`" />
            <KpiTile label="ลาที่บันทึกจาก HIP" :value="`${days(report.recordedTotals.all.recordedDays)} วัน`" :hint="`${report.recordedTotals.all.records - report.recordedTotals.all.needsReviewRecords - report.recordedTotals.all.rejectedRecords} รายการ (ไม่รวมรอตรวจสอบ/ไม่อนุมัติ)`" />
            <KpiTile label="อนุมัติแล้ว" :value="`${days(report.recordedTotals.all.approvedDays)} วัน`" hint="ผู้บริหารอนุมัติแล้ว" />
            <KpiTile label="รออนุมัติ" :value="`${days(report.recordedTotals.all.awaitingApprovalDays)} วัน`" hint="บันทึกแล้ว ยังไม่ผ่านการอนุมัติ" tone="leave" />
            <KpiTile label="รอตรวจสอบ" :value="`${report.recordedTotals.all.needsReviewRecords} รายการ`" hint="ไม่รวมในยอดวัน" tone="late" />
            <KpiTile
              label="เฉลี่ยต่อคนที่มีรายการลา"
              :value="avgPerPerson ? `${avgPerPerson.avg.toFixed(1)} วัน/คน` : NO_DATA"
              :hint="avgPerPerson ? `${days(report.recordedTotals.all.recordedDays)} วัน ÷ ${avgPerPerson.people} คนที่มีรายการลานับยอด (ไม่รวมคนที่ไม่มีรายการลา)` : 'ไม่มีผู้ที่มีรายการลานับยอดในช่วงนี้'"
              tone="info"
            />
          </dl>

          <div class="dist" role="img" :aria-label="`สัดส่วนวันลาตามประเภท: ${slices.map((x) => `${x.label} ${days(x.days)} วัน`).join(', ')}`">
            <div v-if="slices.some((x) => x.days > 0)" class="dist-strip">
              <span v-for="x in slices.filter((y) => y.days > 0)" :key="x.type" :style="{ width: `${x.share * 100}%`, background: x.color }" />
            </div>
            <div v-else class="dist-strip dist-strip--empty" />
            <ul class="legend">
              <li v-for="x in slices" :key="x.type"><i :style="{ background: x.color }" />{{ x.label }} <strong>{{ days(x.days) }}</strong> วัน ({{ Math.round(x.share * 100) }}%)</li>
            </ul>
          </div>
        </template>

        <div class="tabs" role="tablist" aria-label="มุมมองรายงานการลา">
          <button v-for="t in TABS" :id="`tab-${t.id}`" :key="t.id" type="button" role="tab" class="tab" :class="{ 'tab--on': tab === t.id }" :aria-selected="tab === t.id" :aria-controls="`panel-${t.id}`" @click="tab = t.id">
            {{ t.label }}<span v-if="t.id === 'quality' && issues.length" class="tab-badge">{{ issues.length }}</span>
          </button>
        </div>

        <div v-show="tab === 'overview'" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" class="panel">
          <section v-if="balanceState !== 'idle'" class="card">
            <h4>สิทธิ์ลาคงเหลือ <span class="muted">· ปี {{ report.buddhistYear }} · หักเฉพาะวันที่อนุมัติแล้ว</span></h4>
            <p v-if="balanceState === 'loading'" class="muted">กำลังโหลด…</p>
            <p v-else-if="balanceState === 'error'" class="muted">{{ NO_DATA }} — โหลดสิทธิ์ลาไม่สำเร็จ</p>
            <ul v-else class="hbars">
              <li v-for="b in balanceRows" :key="b.type" class="bal">
                <span class="hbar-label">{{ b.label }}</span>
                <span class="muted">{{ b.total === null ? NO_DATA : `สิทธิ์ ${days(b.total)} · ใช้ ${b.used === null ? NO_DATA : days(b.used)} วัน` }}</span>
                <strong class="hbar-val">{{ b.remaining === null ? NO_DATA : `${days(b.remaining)} วัน` }}</strong>
              </li>
            </ul>
          </section>
          <template v-if="report.recordedTotals">
            <div class="chart-grid">
              <section class="card">
                <h4>วันลาแยกตามประเภท <span class="muted">· หน่วย: วัน</span></h4>
                <ul class="hbars">
                  <li v-for="x in slices" :key="x.type">
                    <span class="hbar-label">{{ x.label }}</span>
                    <span class="hbar-track"><span class="hbar-fill" :style="{ width: pct(x.days, maxSlice), background: x.color }" /></span>
                    <strong class="hbar-val">{{ days(x.days) }}</strong>
                  </li>
                </ul>
              </section>
              <section v-if="showDivisions && report.byDivision" class="card">
                <h4>วันลาแยกตามกอง <span class="muted">· แยกตามประเภท · หน่วย: วัน</span></h4>
                <ul class="hbars">
                  <li v-for="d in report.byDivision" :key="d.code" class="hbar-stack">
                    <span class="hbar-label">{{ d.nameTh }}<small class="muted">{{ d.headcount }} คน</small></span>
                    <span class="hbar-track">
                      <span class="stack" :style="{ width: pct(d.recordedDays, divMax) }">
                        <span v-for="t in report.types.filter((y) => d.byType[y.type].days > 0)" :key="t.type" :title="`${t.labelTh} ${days(d.byType[t.type].days)} วัน`" :style="{ flex: d.byType[t.type].days, background: LEAVE_KIND_COLOR[t.type] }" />
                      </span>
                    </span>
                    <strong class="hbar-val">{{ days(d.recordedDays) }}</strong>
                  </li>
                </ul>
                <ul class="legend"><li v-for="x in slices" :key="x.type"><i :style="{ background: x.color }" />{{ x.label }}</li></ul>
              </section>
            </div>

            <section class="card">
              <h4>แนวโน้มวันลารายเดือน <span class="muted">· ปี {{ report.buddhistYear }} · อนุมัติแล้ว / รออนุมัติ</span></h4>
              <p v-if="!trendSource" class="muted">{{ NO_DATA }} — โหลดแนวโน้มทั้งปีไม่สำเร็จ</p>
              <template v-else>
                <div class="trend-scroll"><ol class="trend">
                  <li v-for="p in trend" :key="p.month" :class="{ 'trend--none': p.days === null }">
                    <span class="trend-val">{{ p.days === null ? '' : days(p.days) }}</span>
                    <span class="trend-bar">
                      <template v-if="p.days === null"><span class="trend-nodata">{{ NO_DATA }}</span></template>
                      <template v-else>
                        <span class="seg seg--wait" :style="{ height: pct(p.awaitingDays ?? 0, trendMax) }" />
                        <span class="seg seg--ok" :style="{ height: pct(p.approvedDays ?? 0, trendMax) }" />
                      </template>
                    </span>
                    <span class="trend-label">{{ p.label }}</span>
                  </li>
                </ol></div>
                <ul class="legend"><li><i class="sw sw--ok" />อนุมัติแล้ว</li><li><i class="sw sw--wait" />รออนุมัติ</li><li><i class="sw sw--none" />เดือนที่ไม่มีข้อมูล (ไม่ใช่ 0)</li></ul>
              </template>
            </section>

            <section class="card">
              <h4>สถิติการลารายบุคคล <span class="muted">· 8 อันดับแรก — ดูทั้งหมดที่แท็บ “รายบุคคล”</span></h4>
              <ul class="hbars">
                <li v-for="p in people.slice(0, 8)" :key="p.employeeUid">
                  <span class="hbar-label">{{ p.employeeName }}<small class="muted">{{ p.divisionName }}</small></span>
                  <span class="hbar-track">
                    <span class="stack" :style="{ width: pct(p.recordedDays ?? 0, peopleMax) }">
                      <span v-for="b in p.byType.filter((y) => (y.days ?? 0) > 0)" :key="b.type" :title="`${b.label} ${days(b.days ?? 0)} วัน`" :style="{ flex: b.days ?? 0, background: b.color }" />
                    </span>
                  </span>
                  <strong class="hbar-val">{{ p.recordedDays === null ? NO_DATA : days(p.recordedDays) }}</strong>
                </li>
              </ul>
              <p v-if="!people.length" class="muted">{{ NO_DATA }}</p>
            </section>
          </template>
          <template v-else>
            <p class="muted">{{ NO_DATA }} — ยังไม่มีการนำเข้าข้อมูลการลาที่บันทึกจาก HIP ในช่วงนี้</p>
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

        </div>

        <div v-show="tab === 'people'" id="panel-people" role="tabpanel" aria-labelledby="tab-people" class="panel">
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
                          <span v-if="d.status" :class="leaveRecordChipClass(d.status)">{{ d.statusLabel }}</span>
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

        </div>

        <div v-show="tab === 'divisions'" id="panel-divisions" role="tabpanel" aria-labelledby="tab-divisions" class="panel">
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

          <p v-if="!(showDivisions && report.byDivision)" class="muted">ไม่มีข้อมูลรายกองสำหรับสิทธิ์ของท่าน</p>
        </div>

        <div v-show="tab === 'details'" id="panel-details" role="tabpanel" aria-labelledby="tab-details" class="panel">
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
                    <span :class="leaveRecordChipClass(r.status)">{{ r.statusLabel }}</span>
                    <span v-if="r.reasonLabels.length" class="muted"> {{ r.reasonLabels.join('; ') }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <p v-else-if="report.recordedTotals" class="state state--empty">ไม่พบรายการลาที่ตรงกับตัวกรอง</p>

        </div>

        <div v-show="tab === 'quality'" id="panel-quality" role="tabpanel" aria-labelledby="tab-quality" class="panel">
          <section class="card">
            <h4>ข้อมูลที่ควรตรวจสอบ</h4>
            <ul v-if="issues.length" class="issues">
              <li v-for="i in issues" :key="i.key" :class="`issue issue--${i.tone}`"><strong>{{ i.title }}</strong><span>{{ i.detail }}</span></li>
            </ul>
            <p v-else class="muted">ไม่พบประเด็นที่ต้องตรวจสอบในช่วงนี้</p>
            <p v-if="report.recordedTotals" class="muted">ตรวจสอบรายการรอตรวจสอบ/รออนุมัติได้ที่หน้า “ตรวจสอบการลา” (ผู้บริหาร)</p>
          </section>
        <p v-if="report.recordedTotals" class="muted">
          {{ report.reconciliation.reconciled ? 'ตรวจสอบยอดแล้ว' : 'ยอดไม่ตรงกัน — โปรดแจ้งผู้ดูแลระบบ' }}:
          {{ report.reconciliation.recordsMatched }} รายการ = ผลรวมรายบุคคล = ผลรวมรายกอง = รายการโดยละเอียด
        </p>
        <p v-if="report.recordedTotals" class="muted">{{ report.notices.recordedCounting }}</p>
        <p v-if="report.coverage.hasLeaveData" class="muted">{{ report.notices.dayCounting }}</p>
        </div>
      </template>
    </AsyncState>
  </section>
</template>

<style scoped>
.range-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  font-size: 0.95rem;
  font-weight: 500;
}
.range-toggle input {
  width: 1.15rem;
  height: 1.15rem;
  min-height: 0;
  accent-color: var(--navy-3);
}

.kpi-grid--six { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (min-width: 40rem) { .kpi-grid--six { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (min-width: 75rem) { .kpi-grid--six { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
.kpi-grid--six :deep(.kpi-value) { font-size: 1.6rem; }
.dist { margin: 0 0 1.1rem; }
.dist-strip { display: flex; height: 0.7rem; overflow: hidden; border-radius: 999px; background: var(--empty-bg); }
.dist-strip span { display: block; min-width: 2px; }
.legend { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; margin: 0.6rem 0 0; padding: 0; list-style: none; font-size: 0.85rem; color: var(--muted); }
.legend li { display: inline-flex; align-items: center; gap: 0.35rem; }
.legend i { width: 0.7rem; height: 0.7rem; border-radius: 3px; display: inline-block; }
.sw--ok { background: var(--leave); }
.sw--wait { background: var(--gold); }
.sw--none { background: repeating-linear-gradient(45deg, var(--border-strong) 0 2px, transparent 2px 5px); }
.tabs { display: flex; gap: 0.25rem; overflow-x: auto; margin: 0 0 1rem; border-bottom: 1px solid var(--border); }
.tab { flex: none; min-height: 2.75rem; padding: 0.5rem 1rem; border: 0; border-bottom: 3px solid transparent; background: none; color: var(--muted); font: inherit; font-weight: 600; cursor: pointer; }
.tab:hover { color: var(--text); }
.tab--on { color: var(--emerald-deep); border-bottom-color: var(--emerald); }
.tab-badge { margin-left: 0.4rem; padding: 0 0.45rem; border-radius: 999px; background: var(--late-bg); color: var(--late); font-size: 0.75rem; }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 0.85rem; margin-bottom: 0.85rem; }
.card { margin: 0 0 0.85rem; padding: 1rem 1.1rem; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-1); }
.chart-grid .card { margin: 0; }
.card h4 { margin: 0 0 0.75rem; font-size: 1rem; }
.hbars { display: grid; gap: 0.6rem; margin: 0; padding: 0; list-style: none; }
.hbars li { display: grid; grid-template-columns: minmax(6rem, 10rem) 1fr auto; align-items: center; gap: 0.6rem; font-size: 0.9rem; }
.hbar-label { display: grid; line-height: 1.25; }
.hbar-label small { font-size: 0.75rem; }
.hbar-track { display: flex; height: 1.1rem; border-radius: 4px; background: var(--surface-2); overflow: hidden; }
.hbar-fill { display: block; height: 100%; border-radius: 4px; min-width: 2px; }
.stack { display: flex; height: 100%; min-width: 2px; }
.hbar-val { min-width: 2.2rem; text-align: right; font-variant-numeric: tabular-nums; }
.trend-scroll { overflow-x: auto; padding-bottom: 0.25rem; }
.trend { min-width: 34rem; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 0.4rem; align-items: end; margin: 0; padding: 0; list-style: none; }
.trend li { display: grid; grid-template-rows: 1rem 9rem auto; justify-items: center; gap: 0.2rem; font-size: 0.8rem; }
.trend-bar { display: flex; flex-direction: column; justify-content: flex-end; width: 100%; max-width: 2.2rem; height: 9rem; }
.trend--none .trend-bar { justify-content: center; align-items: center; background: repeating-linear-gradient(45deg, var(--surface-2) 0 3px, transparent 3px 7px); border-radius: 4px; }
.trend-nodata { writing-mode: vertical-rl; font-size: 0.7rem; color: var(--muted); }
.seg { display: block; width: 100%; }
.seg--ok { background: var(--leave); border-radius: 0 0 3px 3px; }
.seg--wait { background: var(--gold); border-radius: 3px 3px 0 0; }
.trend-label { color: var(--muted); white-space: nowrap; font-size: 0.7rem; }
@media (min-width: 40.01rem) { .hbars .bal { grid-template-columns: minmax(6rem, 10rem) 1fr auto; } }
.issues { display: grid; gap: 0.5rem; margin: 0 0 0.75rem; padding: 0; list-style: none; }
.issue { display: grid; gap: 0.15rem; padding: 0.65rem 0.85rem; border: 1px solid var(--border); border-left-width: 4px; border-radius: var(--radius); font-size: 0.92rem; }
.issue--late { background: var(--late-bg); border-left-color: var(--gold-deep); }
.issue--info { background: var(--info-bg); border-left-color: var(--navy-3); }
.issue--muted { background: var(--surface-2); border-left-color: var(--border-strong); }
@media (max-width: 40rem) {
  .hbars li { grid-template-columns: 1fr auto; }
  .hbars .hbar-track { grid-column: 1 / -1; grid-row: 2; }
}
</style>
