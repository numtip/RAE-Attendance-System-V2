<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { DivisionBucket, DivisionReport, OrganizationReportRow } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import PageHeader from '../components/PageHeader.vue';
import KpiTile from '../components/KpiTile.vue';
import PeriodPicker from '../components/PeriodPicker.vue';

const now = new Date();
const year = ref(now.getUTCFullYear());
const month = ref(now.getUTCMonth() + 1);
const loading = ref(false);
const error = ref<string | null>(null);
const report = ref<DivisionReport | null>(null);
const selected = ref<string>('all');
const metric = ref<MetricKey>('avgPresentPerPerson');
const query = ref('');

type MetricKey = 'avgPresentPerPerson' | 'late' | 'lateMinutes' | 'leaveRecordedDays';
const metrics: { key: MetricKey; label: string; unit: string }[] = [
  { key: 'avgPresentPerPerson', label: 'มาทำงานเฉลี่ย/คน', unit: 'วัน' },
  { key: 'late', label: 'มาสาย', unit: 'ครั้ง' },
  { key: 'lateMinutes', label: 'นาทีที่สาย', unit: 'นาที' },
  { key: 'leaveRecordedDays', label: 'ลา (บันทึกจาก HIP)', unit: 'วัน' },
];
const activeMetric = computed(() => metrics.find((m) => m.key === metric.value) ?? metrics[0]);

interface Entry extends DivisionBucket { key: string; name: string; rows: OrganizationReportRow[]; special?: boolean }
const entries = computed<Entry[]>(() => {
  const r = report.value;
  if (!r) return [];
  const list: Entry[] = r.divisions.map((d) => ({ ...d, key: d.code, name: d.nameTh }));
  if (r.unassigned.headcount) list.push({ ...r.unassigned, key: 'unassigned', name: 'ยังไม่ระบุกอง', special: true });
  if (r.ambiguous.headcount) list.push({ ...r.ambiguous, key: 'ambiguous', name: 'สังกัดไม่ชัดเจน (มากกว่า 1 กอง)', special: true });
  return list;
});

function value(e: DivisionBucket): number | null {
  if (metric.value === 'leaveRecordedDays' && !report.value?.recordedLeaveCovered) return null;
  return e[metric.value];
}
const maxValue = computed(() => Math.max(0, ...entries.value.map((e) => value(e) ?? 0)));
function barWidth(e: DivisionBucket): string {
  const v = value(e);
  return !v || !maxValue.value ? '0%' : `${Math.max(3, Math.round((v / maxValue.value) * 100))}%`;
}
function show(v: number | null): string {
  return v === null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1);
}

const drillRows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const source = selected.value === 'all' ? entries.value.flatMap((e) => e.rows) : (entries.value.find((e) => e.key === selected.value)?.rows ?? []);
  return source.filter((row) => !needle || row.employeeId.toLowerCase().includes(needle) || row.employeeName.toLowerCase().includes(needle));
});
const selectedName = computed(() => (selected.value === 'all' ? 'ทุกกอง' : (entries.value.find((e) => e.key === selected.value)?.name ?? '')));

async function load() {
  loading.value = true;
  error.value = null;
  report.value = null;
  selected.value = 'all';
  try {
    report.value = await api.divisionReport(year.value, month.value);
  } catch (e) {
    error.value = e instanceof ApiError && e.status === 403
      ? 'ไม่มีสิทธิ์ดูแดชบอร์ด — ต้องเป็นผู้บริหารหรือผู้จัดการที่ได้รับสิทธิ์'
      : (e instanceof ApiError ? e.message : 'ไม่สามารถโหลดแดชบอร์ดได้');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="ผู้บริหาร" title="แดชบอร์ดผู้บริหาร" subtitle="เปรียบเทียบรายกองจากข้อมูลที่นำเข้า" />
    <PeriodPicker v-model:year="year" v-model:month="month" :loading="loading" @submit="load" />
    <AsyncState :loading="loading" :error="error" :empty="false">
      <template v-if="report">
        <h3 class="section-title">
          {{ report.scope === 'organization' ? 'ภาพรวมทั้งองค์กร' : 'ภาพรวมกองที่ท่านได้รับสิทธิ์' }}
          <span class="muted">· {{ report.periodLabel }}</span>
        </h3>
        <p v-if="report.dataThrough?.partial" class="callout" role="alert">{{ report.dataThrough.note }}</p>
        <p v-else-if="report.dataThrough?.label" class="muted">{{ report.dataThrough.label }}</p>
        <dl class="kpi-grid">
          <KpiTile label="พนักงาน" :value="report.totals.employeesInScope" :hint="`มีสรุปรายเดือน ${report.totals.employeesWithData} · ไม่มี ${report.totals.employeesWithoutData}`" />
          <KpiTile label="มาทำงาน (รวม)" :value="report.totals.present" hint="วัน-คน" />
          <KpiTile label="มาสาย (รวม)" :value="report.totals.late" :hint="`${report.totals.lateMinutes} นาที`" />
          <KpiTile label="ลา — บันทึกจาก HIP (รวม)" :value="report.recordedLeaveCovered ? report.totals.leaveRecordedDays ?? 0 : '—'" :hint="report.recordedLeaveCovered ? `วัน (ครึ่งวัน = 0.5) · รอตรวจสอบ ${report.totals.leaveNeedsReview ?? 0} รายการ ไม่รวมในยอด` : 'เดือนนี้ยังไม่มีข้อมูลการลา'" />
        </dl>

        <p v-if="report.reconciliation.reconciled && !report.reconciliation.unassigned && !report.reconciliation.ambiguous" class="callout" role="status">
          ตรวจสอบยอดแล้ว: {{ report.reconciliation.employeesInScope }} คน = ผลรวมของ {{ report.divisions.length }} กอง และตรงกับยอดรวมองค์กร
        </p>
        <p v-else class="callout" role="alert">
          ยอดรวมตรงกับองค์กร{{ report.reconciliation.reconciled ? '' : ' (ไม่ตรง — โปรดแจ้งผู้ดูแลระบบ)' }}:
          กองที่ระบุแล้ว {{ report.reconciliation.assignedToDivisions }} คน
          <template v-if="report.reconciliation.unassigned"> · ยังไม่ระบุกอง {{ report.reconciliation.unassigned }} คน</template>
          <template v-if="report.reconciliation.ambiguous"> · สังกัดไม่ชัดเจน {{ report.reconciliation.ambiguous }} คน</template>
          — ระบบไม่เดาสังกัดให้ จนกว่าจะมีข้อมูลสังกัดที่ยืนยันแล้ว
        </p>

        <h3 class="section-title">เปรียบเทียบรายกอง</h3>
        <div class="seg" role="group" aria-label="เลือกตัวชี้วัด">
          <button v-for="m in metrics" :key="m.key" type="button" class="seg-btn" :aria-pressed="metric === m.key" @click="metric = m.key">{{ m.label }}</button>
        </div>
        <ul class="division-list">
          <li v-for="e in entries" :key="e.key">
            <button type="button" class="division" :class="{ 'division--on': selected === e.key, 'division--warn': e.special }" :aria-pressed="selected === e.key" @click="selected = selected === e.key ? 'all' : e.key">
              <span class="division-name">{{ e.name }}</span>
              <span class="division-meta">{{ e.headcount }} คน · มีสรุป {{ e.withData }}</span>
              <span class="bar" aria-hidden="true"><span class="bar-fill" :style="{ width: barWidth(e) }"></span></span>
              <span class="division-value">{{ show(value(e)) }} <small>{{ activeMetric.unit }}</small></span>
            </button>
          </li>
        </ul>

        <div class="table-scroll">
          <table class="data-table">
            <caption class="sr-only">สรุปรายกอง</caption>
            <thead>
              <tr><th class="sticky-col">กอง</th><th class="num">คน</th><th class="num">มาทำงาน</th><th class="num">เฉลี่ย/คน</th><th class="num">สาย</th><th class="num">นาทีสาย</th><th class="num">ลา (HIP)</th></tr>
            </thead>
            <tbody>
              <tr v-for="e in entries" :key="e.key">
                <td class="sticky-col">{{ e.name }}</td>
                <td class="num">{{ e.headcount }}</td><td class="num">{{ e.present }}</td><td class="num">{{ show(e.avgPresentPerPerson) }}</td>
                <td class="num">{{ e.late }}</td><td class="num">{{ e.lateMinutes }}</td><td class="num">{{ report.recordedLeaveCovered ? e.leaveRecordedDays : '—' }}</td>
              </tr>
              <tr class="total-row">
                <td class="sticky-col">รวมทั้งหมด</td>
                <td class="num">{{ report.totals.employeesInScope }}</td><td class="num">{{ report.totals.present }}</td><td class="num">—</td>
                <td class="num">{{ report.totals.late }}</td><td class="num">{{ report.totals.lateMinutes }}</td><td class="num">{{ report.recordedLeaveCovered ? report.totals.leaveRecordedDays : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 class="section-title">รายบุคคล — {{ selectedName }}</h3>
        <div class="toolbar">
          <input v-model="query" class="search" type="search" placeholder="ค้นหาชื่อหรือรหัสพนักงาน" aria-label="ค้นหาชื่อหรือรหัสพนักงาน" />
          <button v-if="selected !== 'all'" type="button" class="btn btn--ghost" @click="selected = 'all'">แสดงทุกกอง</button>
          <span class="muted" aria-live="polite">{{ drillRows.length }} คน</span>
        </div>
        <p v-if="drillRows.length === 0" class="state state--empty">ไม่พบรายการ</p>
        <div v-else class="table-scroll">
          <table class="data-table">
            <thead><tr><th class="sticky-col">พนักงาน</th><th class="num">วันทำงาน</th><th class="num">มาทำงาน</th><th class="num">สาย</th><th class="num">นาทีสาย</th><th class="num">ลา (HIP)</th></tr></thead>
            <tbody>
              <tr v-for="row in drillRows" :key="row.employeeId">
                <td class="sticky-col"><strong>{{ row.employeeName }}</strong><br /><span class="muted">{{ row.employeeId }}</span></td>
                <template v-if="row.hasMonthlySummary">
                  <td class="num">{{ row.workDays }}</td><td class="num">{{ row.present }}</td><td class="num">{{ row.late }}</td><td class="num">{{ row.lateMinutes }}</td><td class="num">{{ row.leaveRecordedDays ?? '—' }}</td>
                </template>
                <td v-else colspan="5" class="muted">ไม่มีสรุปรายเดือนที่บันทึกไว้</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="muted">{{ report.notices.membershipNote }} · {{ report.notices.holidayNote }}</p>
      </template>
    </AsyncState>
  </section>
</template>
