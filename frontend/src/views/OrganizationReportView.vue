<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api, downloadOrganizationReport } from '../api/client';
import type { OrganizationReport } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import KpiTile from '../components/KpiTile.vue';
import PeriodPicker from '../components/PeriodPicker.vue';

const now = new Date();
const year = ref(now.getUTCFullYear());
const month = ref(now.getUTCMonth() + 1);

const loading = ref(false);
const error = ref<string | null>(null);
const exportError = ref<string | null>(null);
const report = ref<OrganizationReport | null>(null);
const query = ref('');
const onlyMissing = ref(false);

// Filtering is presentation only: the totals and exports always describe the whole scope the server returned.
const visibleRows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return (report.value?.rows ?? []).filter((row) => (
    (!onlyMissing.value || !row.hasMonthlySummary)
    && (!needle || row.employeeId.toLowerCase().includes(needle) || row.employeeName.toLowerCase().includes(needle))
  ));
});

async function load() {
  loading.value = true;
  error.value = null;
  exportError.value = null;
  report.value = null;
  try {
    report.value = await api.organizationReport(year.value, month.value);
  } catch (e) {
    error.value = e instanceof ApiError && e.status === 403
      ? 'ไม่มีสิทธิ์ดูรายงานองค์กร/ทีม — ต้องเป็นผู้บริหารหรือผู้จัดการที่ได้รับสิทธิ์'
      : (e instanceof ApiError ? e.message : 'ไม่สามารถโหลดรายงานได้');
  } finally {
    loading.value = false;
  }
}

async function download(format: 'pdf' | 'xlsx') {
  exportError.value = null;
  try {
    await downloadOrganizationReport(year.value, month.value, format);
  } catch (e) {
    exportError.value = e instanceof ApiError ? e.message : 'ส่งออกรายงานไม่สำเร็จ';
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="page-head">
      <h2>รายงานองค์กร / ทีม</h2>
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
          {{ report.scope === 'organization' ? 'ภาพรวมทั้งองค์กร' : 'ภาพรวมทีมของท่าน' }}
          <span class="muted">· {{ report.periodLabel }}</span>
        </h3>
        <p class="callout" role="note">{{ report.notices.holidayNote }}</p>
        <dl class="kpi-grid">
          <KpiTile
            label="พนักงานในขอบเขต"
            :value="report.totals.employeesInScope"
            :hint="`มีสรุปรายเดือน ${report.totals.employeesWithData} · ไม่มี ${report.totals.employeesWithoutData}`"
          />
          <KpiTile label="มาทำงาน (รวม)" :value="report.totals.present" hint="วัน-คน" />
          <KpiTile label="มาสาย (รวม)" :value="report.totals.late" :hint="`${report.totals.lateMinutes} นาที`" />
          <KpiTile label="ลา — บันทึกจาก HIP (รวม)" :value="report.totals.leaveRecordedDays ?? '—'" :hint="report.totals.leaveRecordedDays === null ? 'เดือนนี้ยังไม่มีข้อมูลการลา' : `วัน — รอตรวจสอบ ${report.totals.leaveNeedsReview} รายการ (ไม่รวม)`" />
        </dl>
        <div class="toolbar">
          <input v-model="query" class="search" type="search" placeholder="ค้นหาชื่อหรือรหัสพนักงาน" aria-label="ค้นหาชื่อหรือรหัสพนักงาน" />
          <label>
            <input v-model="onlyMissing" type="checkbox" />
            แสดงเฉพาะผู้ที่ไม่มีสรุปรายเดือน
          </label>
          <span class="muted" aria-live="polite">แสดง {{ visibleRows.length }} จาก {{ report.rows.length }} คน</span>
        </div>
        <p v-if="visibleRows.length === 0" class="state state--empty">ไม่พบรายการที่ตรงกับเงื่อนไข</p>
        <div v-else class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th class="sticky-col">พนักงาน</th>
                <th class="num">วันทำงาน</th><th class="num">มาทำงาน</th><th class="num">สาย</th>
                <th class="num">นาทีสาย</th><th class="num">ลา (HIP)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in visibleRows" :key="row.employeeId">
                <td class="sticky-col">
                  <strong>{{ row.employeeName }}</strong><br />
                  <span class="muted">{{ row.employeeId }}</span>
                </td>
                <template v-if="row.hasMonthlySummary">
                  <td class="num">{{ row.workDays }}</td>
                  <td class="num">{{ row.present }}</td>
                  <td class="num">{{ row.late }}</td>
                  <td class="num">{{ row.lateMinutes }}</td>
                  <td class="num">{{ row.leaveRecordedDays ?? '—' }}</td>
                </template>
                <td v-else colspan="5" class="muted">ไม่มีสรุปรายเดือนที่บันทึกไว้</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </AsyncState>
  </section>
</template>
