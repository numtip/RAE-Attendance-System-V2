<script setup lang="ts">
import { errorMessageTh } from '../utils/i18n';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { AttendanceAnalyticsQuery, AttendanceAnalyticsReport, AttendanceAnalyticsRow } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import KpiTile from '../components/KpiTile.vue';
import PageHeader from '../components/PageHeader.vue';
import ThaiDateInput from '../components/ThaiDateInput.vue';
import YearSelect from '../components/YearSelect.vue';
import HipUpload from '../components/HipUpload.vue';
import HolidayManagement from '../components/HolidayManagement.vue';
import { THAI_MONTHS, THAI_MONTHS_SHORT, leaveRecordChipClass } from '../utils/thai';
import {
  NO_DATA, analyticsTrend, completenessLabel, completenessTone, formatLateMinutes,
  matchesSearch, monthLabelTh, topPeopleByWorkdays, trendMax,
} from '../utils/attendanceAnalytics';

const now = new Date();
const year = ref(now.getUTCFullYear());
const month = ref<number>(now.getUTCMonth() + 1); // 0 = whole year
const useRange = ref(false);
const from = ref(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`);
const to = ref(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10));
const division = ref('');
const employeeUid = ref('');
const loading = ref(false);
const error = ref<string | null>(null);
const report = ref<AttendanceAnalyticsReport | null>(null);
const roster = ref<{ uid: string; label: string }[]>([]);
const query = ref('');
const TABS = [
  { id: 'overview', label: 'ภาพรวม' },
  { id: 'people', label: 'รายบุคคล' },
  { id: 'divisions', label: 'รายกอง' },
  { id: 'coverage', label: 'ครอบคลุมข้อมูล' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const tab = ref<TabId>('overview');

const visibleRows = computed(() => (report.value?.rows ?? []).filter((row) => matchesSearch(row, query.value)));
const trend = computed(() => (report.value ? analyticsTrend(report.value, THAI_MONTHS_SHORT) : []));
const trendScale = computed(() => trendMax(trend.value));
const divMax = computed(() => Math.max(0, ...(report.value?.byDivision ?? []).map((d) => d.workdays)));
const topPeople = computed(() => (report.value ? topPeopleByWorkdays(report.value, 8) : []));
const peopleMax = computed(() => Math.max(0, ...topPeople.value.map((p) => p.workdays)));
const showDivisions = computed(() => report.value?.scope !== 'self' && (report.value?.byDivision?.length ?? 0) > 0);
const hasAnyData = computed(() => (report.value?.totals.calculatedDays ?? 0) > 0);
const coverageToneClass = (ratio: number | null) => `chip ${completenessTone(ratio) === 'ok' ? 'chip--ok' : completenessTone(ratio) === 'late' ? 'chip--late' : 'chip--muted'}`;
const pct = (value: number, max: number) => (max > 0 ? `${Math.max(0, Math.min(100, (value / max) * 100))}%` : '0%');
const formatLeaveDays = (days: number) => (Number.isInteger(days) ? `${days}` : days.toFixed(1));

function currentQuery(): AttendanceAnalyticsQuery {
  return {
    year: year.value,
    month: month.value || null,
    from: useRange.value ? from.value : undefined,
    to: useRange.value ? to.value : undefined,
    division: division.value || undefined,
    employeeUid: employeeUid.value || undefined,
  };
}

let loadId = 0;
async function load() {
  loadId += 1;
  loading.value = true;
  error.value = null;
  query.value = '';
  try {
    const result = await api.attendanceAnalytics(currentQuery());
    report.value = result;
    // The employee picker lists everyone the current division/scope allows (not just the picked person).
    if (!employeeUid.value) {
      roster.value = result.rows.map((row) => ({ uid: row.employeeUid, label: `${row.employeeId} · ${row.employeeName}` }));
    }
  } catch (e) {
    error.value = errorMessageTh(e, 'ไม่สามารถโหลดรายงานวิเคราะห์การเข้างานได้');
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
  query.value = '';
  void load();
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="การเข้างาน" title="วิเคราะห์การเข้างาน" subtitle="ตัวชี้วัดจากข้อมูลลงเวลาที่คำนวณแล้ว (AR-0001) แสดงความครบถ้วนของข้อมูลและเดือนที่ยังไม่ครบอย่างชัดเจน — ไม่มี KPI การขาดงาน">
      <span class="badge" :class="report?.scope === 'organization' ? 'badge--org' : ''">
        {{ report ? (report.scope === 'organization' ? 'ทั้งองค์กร' : report.scope === 'team' ? 'ทีมของท่าน' : 'ของฉัน') : '…' }}
      </span>
    </PageHeader>

    <HipUpload v-if="report?.scope === 'organization'" @imported="load" />
    <HolidayManagement v-if="report?.scope === 'organization'" :year="year" @changed="load" />

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
        <select v-model="employeeUid" @change="load">
          <option value="">ทุกคน</option>
          <option v-for="r in roster" :key="r.uid" :value="r.uid">{{ r.label }}</option>
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

    <AsyncState :loading="loading" :error="error" :empty="false">
      <template v-if="report">
        <h3 class="section-title">
          {{ report.scope === 'organization' ? 'ทั้งองค์กร' : report.scope === 'team' ? 'ทีมของท่าน' : 'ของฉัน' }}
          <span class="muted">· {{ report.periodLabel }}</span>
        </h3>

        <p v-if="report.dataThrough?.partial" class="callout" role="alert">{{ report.dataThrough.note }}</p>
        <p v-else-if="report.dataThrough?.label" class="muted">{{ report.dataThrough.label }}</p>
        <p v-if="!report.dataThrough?.through" class="callout" role="status">
          ยังไม่มีข้อมูลการเข้างานที่นำเข้าในช่วงนี้ — ไม่ได้หมายความว่าไม่มีการมาทำงาน
        </p>
        <p v-if="report.coverage.uncoveredMonths.length" class="callout" role="status">
          {{ report.coverage.uncoveredMonths.length }} เดือนในช่วงนี้ยังไม่มีข้อมูลที่นำเข้า ({{ report.coverage.uncoveredMonths.join(', ') }}) — แสดงเป็น “ไม่มีข้อมูล” ไม่ใช่ศูนย์
        </p>

        <dl class="kpi-grid kpi-grid--six">
          <KpiTile
            label="พนักงานในขอบเขต"
            :value="`${report.totals.employeesInScope} คน`"
            :hint="`${report.totals.employeesWithRecords} คนมีวันที่บันทึกข้อมูล (${Math.round((report.totals.employeeCoverage.ratio ?? 0) * 100)}%)`"
          />
          <KpiTile
            label="วันทำงานที่บันทึก"
            :value="`${report.totals.workdays} วัน`"
            :hint="`คำนวณแล้ว ${report.totals.calculatedDays} ของ ${report.totals.expectedDays} วันทำงานตามปฏิทิน`"
            tone="info"
          />
          <KpiTile
            label="เข้างานสาย"
            :value="`${report.totals.lateArrivals} ครั้ง`"
            :hint="`พบใน ${report.rows.filter((r) => r.lateArrivals > 0).length} คน`"
            tone="late"
          />
          <KpiTile
            label="ออกก่อนเวลา"
            :value="`${report.totals.earlyDepartures} ครั้ง`"
            :hint="`รวม ${formatLateMinutes(report.totals.earlyMinutes)}`"
            tone="late"
          />
          <KpiTile
            label="นาทีที่สายสะสม"
            :value="formatLateMinutes(report.totals.lateMinutes)"
            :hint="`เฉลี่ย ${report.totals.lateArrivals ? Math.round(report.totals.lateMinutes / report.totals.lateArrivals) : 0} นาที/ครั้ง`"
            tone="info"
          />
          <KpiTile
            label="ความครบถ้วนของข้อมูล"
            :value="completenessLabel(report.totals.completeness)"
            :hint="`ยังไม่มีข้อมูล ${report.totals.noDataDays + report.totals.pendingPolicyDays} วันทำงาน (ไม่ใช่การขาดงาน)`"
            :tone="report.totals.completeness !== null && report.totals.completeness < 0.7 ? 'late' : 'default'"
          />
        </dl>

        <div class="tabs" role="tablist" aria-label="มุมมองรายงานการเข้างาน">
          <button v-for="t in TABS" :id="`tab-${t.id}`" :key="t.id" type="button" role="tab" class="tab" :class="{ 'tab--on': tab === t.id }" :aria-selected="tab === t.id" :aria-controls="`panel-${t.id}`" @click="tab = t.id">
            {{ t.label }}
          </button>
        </div>

        <div v-show="tab === 'overview'" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" class="panel">
          <template v-if="hasAnyData">
            <div class="chart-grid">
              <section class="card">
                <h4>สาย / ออกก่อนเวลารายเดือน <span class="muted">· ปี {{ report.buddhistYear }} · หน่วย: ครั้ง</span></h4>
                <div class="trend-scroll"><ol class="trend">
                  <li v-for="p in trend" :key="p.month" :class="{ 'trend--none': p.lateArrivals === null }">
                    <span class="trend-val">{{ p.lateArrivals === null ? '' : p.lateArrivals + (p.earlyDepartures ?? 0) }}</span>
                    <span class="trend-bar">
                      <template v-if="p.lateArrivals === null"><span class="trend-nodata">{{ NO_DATA }}</span></template>
                      <template v-else>
                        <span class="seg seg--early" :style="{ height: pct(p.earlyDepartures ?? 0, trendScale) }" />
                        <span class="seg seg--late" :style="{ height: pct(p.lateArrivals ?? 0, trendScale) }" />
                      </template>
                    </span>
                    <span class="trend-label">{{ p.label }}<small v-if="p.partial" class="partial-dot" title="เดือนนี้ข้อมูลยังไม่ครบ">•</small></span>
                  </li>
                </ol></div>
                <ul class="legend">
                  <li><i class="sw sw--late" />เข้างานสาย</li>
                  <li><i class="sw sw--early" />ออกก่อนเวลา</li>
                  <li><i class="sw sw--none" />เดือนที่ไม่มีข้อมูล (ไม่ใช่ 0)</li>
                </ul>
              </section>
              <section v-if="showDivisions" class="card">
                <h4>วันทำงานที่บันทึกรายกอง <span class="muted">· หน่วย: วัน</span></h4>
                <ul class="hbars">
                  <li v-for="d in report.byDivision" :key="d.code">
                    <span class="hbar-label">{{ d.nameTh }}<small class="muted">{{ d.employeesWithRecords }}/{{ d.headcount }} คนมีข้อมูล</small></span>
                    <span class="hbar-track"><span class="hbar-fill hbar-fill--ok" :style="{ width: pct(d.workdays, divMax) }" /></span>
                    <strong class="hbar-val">{{ d.workdays }}</strong>
                  </li>
                </ul>
                <p class="muted">ความครบถ้วนรายกองแสดงในแท็บ “รายกอง”</p>
              </section>
            </div>

            <section class="card">
              <h4>วันทำงานที่บันทึกรายบุคคล <span class="muted">· 8 อันดับแรก — ดูทั้งหมดที่แท็บ “รายบุคคล”</span></h4>
              <ul class="hbars">
                <li v-for="p in topPeople" :key="p.employeeUid">
                  <span class="hbar-label">{{ p.employeeName }}<small class="muted">{{ p.divisionName }}</small></span>
                  <span class="hbar-track">
                    <span class="stack" :style="{ width: pct(p.workdays, peopleMax) }">
                      <span class="stack-ok" :style="{ flex: p.workdays - p.lateArrivals }" />
                      <span class="stack-late" :style="{ flex: p.lateArrivals }" />
                    </span>
                  </span>
                  <strong class="hbar-val">{{ p.workdays }} <small class="muted">สาย {{ p.lateArrivals }}</small></strong>
                </li>
              </ul>
              <p v-if="!topPeople.length" class="muted">{{ NO_DATA }}</p>
              <ul class="legend"><li><i class="sw sw--ok" />มาทำงานตามเวลา</li><li><i class="sw sw--late" />มาสาย</li></ul>
            </section>
          </template>
          <p v-else class="muted">{{ NO_DATA }} — ยังไม่มีวันที่คำนวณผลได้ในช่วงนี้ (ข้อมูลยังไม่ถูกนำเข้า)</p>
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
                  <th class="num">วันทำงาน</th>
                  <th class="num">เข้างานสาย</th>
                  <th class="num">ออกก่อนเวลา</th>
                  <th class="num">นาทีสายสะสม</th>
                  <th class="num">ยังไม่มีข้อมูล</th>
                  <th class="num">ลา — อนุมัติ / รออนุมัติ</th>
                  <th class="num">ความครบถ้วน</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in visibleRows" :key="row.employeeUid">
                  <td class="sticky-col">
                    <strong>{{ row.employeeName }}</strong><br />
                    <span class="muted">{{ row.employeeId }} · {{ row.divisionName }}</span>
                  </td>
                  <td class="num" :class="{ muted: !row.hasData }">{{ row.hasData ? row.workdays : '—' }}</td>
                  <td class="num" :class="{ muted: !row.hasData }">{{ row.hasData ? row.lateArrivals : '—' }}</td>
                  <td class="num" :class="{ muted: !row.hasData }">{{ row.hasData ? row.earlyDepartures : '—' }}</td>
                  <td class="num" :class="{ muted: !row.hasData }">{{ row.hasData ? formatLateMinutes(row.lateMinutes) : '—' }}</td>
                  <td class="num">{{ row.noDataDays + row.pendingPolicyDays }}</td>
                  <td class="num">
                    <template v-if="row.leaveApprovedDays || row.leaveAwaitingDays || row.leaveNeedsReviewRecords">
                      {{ row.leaveApprovedDays }} / {{ row.leaveAwaitingDays }} วัน
                      <span v-if="row.leaveNeedsReviewRecords" :class="leaveRecordChipClass('needs_review')">รอตรวจสอบ {{ row.leaveNeedsReviewRecords }}</span>
                    </template>
                    <template v-else><span class="muted">—</span></template>
                  </td>
                  <td class="num"><span :class="coverageToneClass(row.completeness)">{{ completenessLabel(row.completeness) }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-show="tab === 'divisions'" id="panel-divisions" role="tabpanel" aria-labelledby="tab-divisions" class="panel">
          <template v-if="showDivisions">
            <h4 class="section-title">สรุปรายกอง</h4>
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>กอง</th><th class="num">คน</th><th class="num">มีข้อมูล</th>
                    <th class="num">วันทำงาน</th><th class="num">เข้างานสาย</th><th class="num">ออกก่อนเวลา</th>
                    <th class="num">นาทีสายสะสม</th><th class="num">ยังไม่มีข้อมูล</th><th class="num">ความครบถ้วน</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="d in report.byDivision" :key="d.code">
                    <td>{{ d.nameTh }}</td>
                    <td class="num">{{ d.headcount }}</td>
                    <td class="num">{{ d.employeesWithRecords }}</td>
                    <td class="num"><strong>{{ d.workdays }}</strong></td>
                    <td class="num">{{ d.lateArrivals }}</td>
                    <td class="num">{{ d.earlyDepartures }}</td>
                    <td class="num">{{ formatLateMinutes(d.lateMinutes) }}</td>
                    <td class="num">{{ d.noDataDays + d.pendingPolicyDays }}</td>
                    <td class="num"><span :class="coverageToneClass(d.completeness)">{{ completenessLabel(d.completeness) }}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
          <p v-else class="muted">ไม่มีข้อมูลรายกองสำหรับสิทธิ์ของท่าน</p>
        </div>

        <div v-show="tab === 'coverage'" id="panel-coverage" role="tabpanel" aria-labelledby="tab-coverage" class="panel">
          <section class="card">
            <h4>ครอบคลุมข้อมูลรายเดือน <span class="muted">· เดือนที่ไม่มีข้อมูลแสดง “ไม่มีข้อมูล” ไม่ใช่ศูนย์</span></h4>
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>เดือน</th><th>สถานะข้อมูล</th><th>ข้อมูลถึง</th>
                    <th class="num">วันทำงาน</th><th class="num">สาย</th><th class="num">ออกก่อนเวลา</th>
                    <th class="num">นาทีสายสะสม</th><th class="num">ความครบถ้วน</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="m in report.coverage.months" :key="m.month" :class="{ 'row--none': !m.covered }">
                    <td>{{ monthLabelTh(m.month, THAI_MONTHS) }}</td>
                    <td>
                      <span v-if="!m.covered" class="chip chip--muted">ไม่มีข้อมูล</span>
                      <span v-else-if="m.partial" class="chip chip--late">บางส่วน</span>
                      <span v-else class="chip chip--ok">ครบเดือน</span>
                    </td>
                    <td>{{ m.throughLabel ?? '—' }}</td>
                    <td class="num" :class="{ muted: !m.covered }">{{ m.covered ? m.workdays : '—' }}</td>
                    <td class="num" :class="{ muted: !m.covered }">{{ m.covered ? m.lateArrivals : '—' }}</td>
                    <td class="num" :class="{ muted: !m.covered }">{{ m.covered ? m.earlyDepartures : '—' }}</td>
                    <td class="num" :class="{ muted: !m.covered }">{{ m.covered ? formatLateMinutes(m.lateMinutes) : '—' }}</td>
                    <td class="num"><span :class="coverageToneClass(m.completeness)">{{ m.covered ? completenessLabel(m.completeness) : NO_DATA }}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="muted">{{ report.coverage.workdayBasisNote }}</p>
          </section>

          <section class="card">
            <h4>ข้อมูลที่ถูกตัดออกจากตัวชี้วัด</h4>
            <ul class="issues">
              <li v-if="report.coverage.quarantinedScansExcluded" class="issue issue--muted">
                <strong>สแกนที่ระบุตัวตนไม่ได้ (quarantine): {{ report.coverage.quarantinedScansExcluded.count }} รายการ</strong>
                <span>{{ report.coverage.quarantinedNote }}</span>
              </li>
              <li class="issue issue--info">
                <strong>การลาที่ยังไม่อนุมัติ</strong>
                <span>รออนุมัติ {{ formatLeaveDays(report.totals.leaveAwaitingDays) }} · รอตรวจสอบ {{ report.totals.leaveNeedsReviewRecords }} รายการ — {{ report.coverage.leaveApprovalNote }}</span>
              </li>
              <li class="issue issue--muted">
                <strong>ไม่มี KPI การขาดงาน</strong>
                <span>{{ report.notices.noAbsent }}</span>
              </li>
              <li class="issue issue--muted">
                <strong>พื้นฐานการนับ</strong>
                <span>{{ report.notices.countingBasis }} · {{ report.notices.holidayNote }}</span>
              </li>
            </ul>
            <p class="muted">
              {{ report.reconciliation.reconciled ? 'ตรวจสอบยอดแล้ว' : 'ยอดไม่ตรงกัน — โปรดแจ้งผู้ดูแลระบบ' }}:
              {{ report.reconciliation.daysInTotals }} วัน = ผลรวมรายกอง = ผลรวมรายบุคคล = ผลรวมรายเดือน
            </p>
          </section>
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
.badge--org { background: var(--emerald); color: #fff; }

.tabs { display: flex; gap: 0.25rem; overflow-x: auto; margin: 0 0 1rem; border-bottom: 1px solid var(--border); }
.tab { flex: none; min-height: 2.75rem; padding: 0.5rem 1rem; border: 0; border-bottom: 3px solid transparent; background: none; color: var(--muted); font: inherit; font-weight: 600; cursor: pointer; }
.tab:hover { color: var(--text); }
.tab--on { color: var(--emerald-deep); border-bottom-color: var(--emerald); }

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
.hbar-fill--ok { background: var(--leave); }
.hbar-val { min-width: 2.2rem; text-align: right; font-variant-numeric: tabular-nums; }
.stack { display: flex; height: 100%; min-width: 2px; }
.stack-ok { background: var(--leave); }
.stack-late { background: var(--gold); }

.trend-scroll { overflow-x: auto; padding-bottom: 0.25rem; }
.trend { min-width: 34rem; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 0.4rem; align-items: end; margin: 0; padding: 0; list-style: none; }
.trend li { display: grid; grid-template-rows: 1rem 9rem auto; justify-items: center; gap: 0.2rem; font-size: 0.8rem; }
.trend-bar { display: flex; flex-direction: column; justify-content: flex-end; width: 100%; max-width: 2.2rem; height: 9rem; }
.trend--none .trend-bar { justify-content: center; align-items: center; background: repeating-linear-gradient(45deg, var(--surface-2) 0 3px, transparent 3px 7px); border-radius: 4px; }
.trend-nodata { writing-mode: vertical-rl; font-size: 0.7rem; color: var(--muted); }
.seg { display: block; width: 100%; }
.seg--late { background: var(--gold); border-radius: 3px 3px 0 0; }
.seg--early { background: var(--navy-3); border-radius: 0 0 3px 3px; }
.trend-label { color: var(--muted); white-space: nowrap; font-size: 0.7rem; }
.partial-dot { color: var(--gold-deep); margin-left: 0.15rem; }

.legend { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; margin: 0.6rem 0 0; padding: 0; list-style: none; font-size: 0.85rem; color: var(--muted); }
.legend li { display: inline-flex; align-items: center; gap: 0.35rem; }
.legend i { width: 0.7rem; height: 0.7rem; border-radius: 3px; display: inline-block; }
.sw--ok { background: var(--leave); }
.sw--late { background: var(--gold); }
.sw--early { background: var(--navy-3); }
.sw--none { background: repeating-linear-gradient(45deg, var(--border-strong) 0 2px, transparent 2px 5px); }

.issues { display: grid; gap: 0.5rem; margin: 0 0 0.75rem; padding: 0; list-style: none; }
.issue { display: grid; gap: 0.15rem; padding: 0.65rem 0.85rem; border: 1px solid var(--border); border-left-width: 4px; border-radius: var(--radius); font-size: 0.92rem; }
.issue--info { background: var(--info-bg); border-left-color: var(--navy-3); }
.issue--muted { background: var(--surface-2); border-left-color: var(--border-strong); }

.row--none { color: var(--muted); }
@media (max-width: 40rem) {
  .hbars li { grid-template-columns: 1fr auto; }
  .hbars .hbar-track { grid-column: 1 / -1; grid-row: 2; }
}
</style>
