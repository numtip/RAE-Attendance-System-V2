<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { EntitlementFactsInput, EntitlementOverview, EntitlementRow, EntitlementScope } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import EntitlementEditDialog from '../components/EntitlementEditDialog.vue';
import KpiTile from '../components/KpiTile.vue';
import PageHeader from '../components/PageHeader.vue';
import { errorMessageTh, leaveTypeLabel } from '../utils/i18n';
import { employeeTypeLabel } from '../utils/thai';
import {
  DEFAULT_FISCAL_YEAR_BE, LEAVE_KINDS, cellView, filterRows, fiscalRangeTh, fiscalYearOptions, formatDays, missingLabelTh, scopeLabelTh,
} from '../utils/leaveEntitlement';

// One request loads everyone in scope; the filters below work on that data in the browser (no per-person requests).
const fiscalYear = ref(DEFAULT_FISCAL_YEAR_BE);
const division = ref('');
const loading = ref(false);
const error = ref<string | null>(null);
const engineOff = ref(false);
const data = ref<EntitlementOverview | null>(null);
const query = ref('');
const scope = ref<'' | EntitlementScope>('');
const missingOnly = ref(false);

const editing = ref<EntitlementRow | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);
const notice = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  engineOff.value = false;
  try {
    data.value = await api.leaveEntitlements(fiscalYear.value, division.value);
  } catch (e) {
    data.value = null;
    if (e instanceof ApiError && e.code === 'LEAVE_ENTITLEMENT_ENGINE_OFF') engineOff.value = true;
    else if (e instanceof ApiError && e.status === 403) error.value = 'หน้านี้สำหรับผู้บริหารหรือผู้จัดการที่ได้รับสิทธิ์เท่านั้น';
    else error.value = errorMessageTh(e, 'ไม่สามารถโหลดสิทธิ์วันลาได้');
  } finally {
    loading.value = false;
  }
}

const visible = computed(() => (data.value ? filterRows(data.value.rows, { query: query.value, scope: scope.value, division: '', missingOnly: missingOnly.value }) : []));
const missingChips = computed(() => Object.entries(data.value?.summary.missing ?? {}).sort((a, b) => b[1] - a[1]));

function openEdit(row: EntitlementRow) { saveError.value = null; notice.value = null; editing.value = row; }
async function save(body: EntitlementFactsInput) {
  const row = editing.value;
  if (!row) return;
  saving.value = true;
  saveError.value = null;
  try {
    const result = await api.saveLeaveEntitlementFacts(row.employeeUid, fiscalYear.value, body);
    editing.value = null;
    notice.value = result.changed > 0 ? `บันทึกแล้ว ${result.changed} รายการ (มีประวัติการแก้ไข)` : 'ไม่มีการเปลี่ยนแปลง';
    await load();
  } catch (e) {
    saveError.value = errorMessageTh(e, 'ไม่สามารถบันทึกได้');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="การลา" title="สิทธิ์วันลาตามปีงบประมาณ" subtitle="สิทธิ์ ยกยอด วันลาที่อนุมัติแล้ว และวันคงเหลือของพนักงานทุกคนในขอบเขต ตามประกาศ มจ. พ.ศ. 2569 (ปีงบประมาณ 1 ต.ค. – 30 ก.ย.) — ข้อมูลที่ยังไม่ครบแสดงว่า ไม่มีข้อมูล ไม่ใช่ 0" />
    <form class="period" @submit.prevent="load">
      <label class="field">
        <span>ปีงบประมาณ (พ.ศ.)</span>
        <select v-model.number="fiscalYear">
          <option v-for="y in fiscalYearOptions()" :key="y" :value="y">{{ y }}</option>
        </select>
      </label>
      <label class="field">
        <span>กอง</span>
        <select v-model="division">
          <option value="">ทุกกอง</option>
          <option v-for="d in data?.divisions ?? []" :key="d.code" :value="d.code">{{ d.nameTh }}</option>
        </select>
      </label>
      <button type="submit" class="btn btn--primary" :disabled="loading">{{ loading ? 'กำลังโหลด…' : 'แสดงข้อมูล' }}</button>
    </form>

    <p v-if="engineOff" class="callout" role="status">ระบบคำนวณสิทธิ์วันลาตามปีงบประมาณยังไม่เปิดใช้งาน</p>
    <p v-if="notice" class="callout" role="status">{{ notice }}</p>

    <AsyncState :loading="loading && !data" :error="error" :empty="!loading && !error && !engineOff && !data" empty-message="ไม่มีข้อมูล">
      <template v-if="data">
        <p class="muted">ปีงบประมาณ {{ data.fiscalYear.be }}: {{ fiscalRangeTh({ fiscalYear: data.fiscalYear }) }}<template v-if="data.flag === 'shadow'"> · อยู่ระหว่างตรวจสอบ (shadow)</template></p>
        <dl class="kpi-grid">
          <KpiTile label="พนักงานในขอบเขต" :value="`${data.summary.headcount} คน`" />
          <KpiTile label="อยู่ในประกาศ" :value="`${data.summary.inPolicy} คน`" tone="info" />
          <KpiTile label="รอยืนยันสิทธิ์" :value="`${data.summary.unconfirmed} คน`" hint="ประเภทบุคลากรที่ประกาศไม่ได้ระบุ" tone="late" />
          <KpiTile label="อยู่นอกประกาศ" :value="`${data.summary.excluded} คน`" hint="เช่น พนักงานจ้างเหมา" />
          <KpiTile label="คำนวณครบทั้ง 3 ประเภท" :value="`${data.summary.fullyDetermined} คน`" tone="leave" />
        </dl>

        <ul class="ent-type-grid">
          <li v-for="t in LEAVE_KINDS" :key="t">
            <p class="balance-type">{{ leaveTypeLabel(t) }}</p>
            <p><strong>{{ data.summary.byType[t].determined }}</strong> <span class="muted">คนที่คำนวณวันคงเหลือได้</span></p>
            <p class="muted">เฉพาะคนที่คำนวณได้: สิทธิ์รวม {{ formatDays(data.summary.byType[t].entitlementDays) }} · ใช้ไป {{ formatDays(data.summary.byType[t].usedDays) }} · คงเหลือ {{ formatDays(data.summary.byType[t].remainingDays) }} วัน</p>
          </li>
        </ul>

        <template v-if="missingChips.length">
          <p class="muted">ข้อมูลที่ยังขาด (นับจำนวนคนที่อยู่ในประกาศหรือรอยืนยัน):</p>
          <ul class="ent-missing">
            <li v-for="[code, n] in missingChips" :key="code" class="chip chip--late">{{ missingLabelTh(code) }} · {{ n }} คน</li>
          </ul>
        </template>

        <div class="toolbar">
          <label class="field"><span>ค้นหา</span><input v-model="query" type="search" placeholder="รหัส หรือ ชื่อ" /></label>
          <label class="field">
            <span>สถานะ</span>
            <select v-model="scope">
              <option value="">ทั้งหมด</option>
              <option value="in_policy">อยู่ในประกาศ</option>
              <option value="unconfirmed">รอยืนยันสิทธิ์</option>
              <option value="excluded">อยู่นอกประกาศ</option>
            </select>
          </label>
          <label class="field field--inline"><input v-model="missingOnly" type="checkbox" /> <span>เฉพาะที่ต้องกรอกข้อมูล</span></label>
        </div>

        <p class="muted">ตัวเลขในตารางคือวันคงเหลือ และ “จาก” คือสิทธิ์ของปีนี้รวมยกยอด (วันทำงาน)</p>
        <p v-if="visible.length === 0" class="state state--empty">ไม่พบรายการที่ตรงกับตัวกรอง</p>
        <div v-else class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">พนักงาน</th>
                <th scope="col">สถานะ</th>
                <th v-for="t in LEAVE_KINDS" :key="t" scope="col">{{ leaveTypeLabel(t) }}</th>
                <th scope="col">ยกยอดพักผ่อน</th>
                <th v-if="data.canEdit" scope="col"><span class="sr-only">แก้ไข</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in visible" :key="row.employeeUid">
                <td class="ent-person">
                  <strong>{{ row.name }}</strong>
                  <span class="muted">{{ row.employeeId }} · {{ employeeTypeLabel(row.employeeType) }}</span>
                  <span class="muted">{{ row.division.nameTh }}</span>
                </td>
                <td>
                  <span class="chip" :class="row.scope === 'in_policy' ? 'chip--ok' : (row.scope === 'unconfirmed' ? 'chip--late' : 'chip--muted')">{{ scopeLabelTh(row.scope) }}</span>
                  <span v-if="row.scope !== 'excluded' && row.missing.length" class="muted">ขาด: {{ row.missing.map(missingLabelTh).join(', ') }}</span>
                </td>
                <td v-for="t in LEAVE_KINDS" :key="t">
                  <div class="ent-cell" :class="`ent-cell--${cellView(row.types[t]).tone}`">
                    <strong>{{ cellView(row.types[t]).text }}</strong>
                    <span v-if="cellView(row.types[t]).sub" class="muted">{{ cellView(row.types[t]).sub }}</span>
                    <div v-if="cellView(row.types[t]).meter !== null" class="ent-meter" aria-hidden="true"><span class="meter-fill" :style="{ width: `${cellView(row.types[t]).meter}%` }"></span></div>
                  </div>
                </td>
                <td>{{ row.scope === 'excluded' ? '—' : formatDays(row.types.vacation?.carryoverDays) }}</td>
                <td v-if="data.canEdit"><button type="button" class="btn btn--ghost" @click="openEdit(row)">กรอก/แก้ไข</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </AsyncState>

    <EntitlementEditDialog v-if="data" :row="editing" :fiscal-year-be="fiscalYear" :busy="saving" :error="saveError" @save="save" @cancel="editing = null" />
  </section>
</template>
