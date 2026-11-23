<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api, downloadEntitlementTemplate } from '../api/client';
import type { EntitlementFactsInput, EntitlementOverview, EntitlementRow, EntitlementScope, ImportResult } from '../api/types';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import AsyncState from '../components/AsyncState.vue';
import EntitlementEditDialog from '../components/EntitlementEditDialog.vue';
import KpiTile from '../components/KpiTile.vue';
import PageHeader from '../components/PageHeader.vue';
import { errorMessageTh, leaveTypeLabel } from '../utils/i18n';
import { employeeTypeLabel } from '../utils/thai';
import {
  DEFAULT_FISCAL_YEAR_BE, LEAVE_KINDS, canConfirmImport, cellView, findingLabelTh, groupFindings, filterRows, fiscalRangeTh, fiscalYearOptions, formatDays, missingLabelTh, scopeLabelTh,
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

// ---- bulk eligibility (owner only): tick people, then confirm / decline / clear their eligibility in one step ----
const selected = ref<Set<string>>(new Set());
const bulkOpen = ref(false);
const bulkChoice = ref<'yes' | 'no' | 'clear'>('yes');
const bulkReference = ref('');
const bulkBusy = ref(false);
const bulkError = ref<string | null>(null);
const selectable = (r: EntitlementRow) => r.scope !== 'excluded';
const selectedCount = computed(() => selected.value.size);
const allVisibleSelected = computed(() => visible.value.filter(selectable).length > 0 && visible.value.filter(selectable).every((r) => selected.value.has(r.employeeUid)));
function toggle(uid: string) {
  const next = new Set(selected.value);
  if (next.has(uid)) next.delete(uid); else next.add(uid);
  selected.value = next;
}
function toggleAllVisible() {
  const next = new Set(selected.value);
  const rows = visible.value.filter(selectable);
  if (allVisibleSelected.value) for (const r of rows) next.delete(r.employeeUid); else for (const r of rows) next.add(r.employeeUid);
  selected.value = next;
}
function selectUnconfirmed() {
  selected.value = new Set((data.value?.rows ?? []).filter((r) => r.scope === 'unconfirmed').map((r) => r.employeeUid));
}
function openBulk() { bulkError.value = null; bulkOpen.value = true; }
async function confirmBulk() {
  bulkBusy.value = true;
  bulkError.value = null;
  try {
    const confirmed = bulkChoice.value === 'yes' ? true : (bulkChoice.value === 'no' ? false : null);
    const result = await api.bulkLeaveEligibility({ employeeUids: [...selected.value], confirmed, ...(bulkReference.value.trim() ? { reference: bulkReference.value.trim() } : {}) });
    bulkOpen.value = false;
    selected.value = new Set();
    notice.value = `บันทึกการยืนยันสิทธิ์แล้ว ${result.changed} คน${result.unchanged ? ` (ไม่เปลี่ยนแปลง ${result.unchanged} คน)` : ''}${result.failed.length ? ` · ไม่สำเร็จ ${result.failed.length} คน` : ''} — มีประวัติการแก้ไข`;
    await load();
  } catch (e) {
    bulkError.value = errorMessageTh(e, 'ไม่สามารถบันทึกได้');
  } finally {
    bulkBusy.value = false;
  }
}

// ---- templates and upload (owner only): download -> fill -> upload -> dry run -> confirm ----
const files = ref<{ profile: string | null; entitlement: string | null }>({ profile: null, entitlement: null });
const fileNames = ref<{ profile: string; entitlement: string }>({ profile: '', entitlement: '' });
const importBusy = ref(false);
const importError = ref<string | null>(null);
const importResult = ref<ImportResult | null>(null);
const importConfirmOpen = ref(false);
const downloadError = ref<string | null>(null);
const findingGroups = computed(() => groupFindings(importResult.value?.findings ?? []));
const canConfirm = computed(() => canConfirmImport(importResult.value as never));
async function download(kind: 'profile' | 'entitlement', format: 'csv' | 'xlsx') {
  downloadError.value = null;
  try { await downloadEntitlementTemplate(kind, format, fiscalYear.value); } catch (e) { downloadError.value = errorMessageTh(e, 'ดาวน์โหลดไม่สำเร็จ'); }
}
async function pickFile(kind: 'profile' | 'entitlement', event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  importResult.value = null;
  importError.value = null;
  if (!file) { files.value[kind] = null; fileNames.value[kind] = ''; return; }
  files.value[kind] = await file.text();
  fileNames.value[kind] = file.name;
}
async function runImport(confirm: boolean) {
  importBusy.value = true;
  importError.value = null;
  try {
    importResult.value = await api.importLeaveEntitlementFiles({
      ...(files.value.profile ? { profile: files.value.profile } : {}), ...(files.value.entitlement ? { entitlement: files.value.entitlement } : {}), confirm,
    });
    if (confirm && importResult.value.written) { notice.value = 'นำเข้าข้อมูลเรียบร้อย (มีประวัติการแก้ไข)'; await load(); }
  } catch (e) {
    importError.value = errorMessageTh(e, 'ไม่สามารถตรวจสอบไฟล์ได้');
  } finally {
    importBusy.value = false;
    importConfirmOpen.value = false;
  }
}
const fileLabel = (k: string) => (k === 'profile' ? 'ข้อมูลบุคลากร' : 'สิทธิ์วันลา');

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

        <details v-if="data.canEdit" class="ent-panel">
          <summary>จัดการข้อมูลทีละหลายคน: ดาวน์โหลดแบบฟอร์ม / อัปโหลดไฟล์</summary>
          <p class="muted">ดาวน์โหลดแบบฟอร์ม (มีข้อมูลปัจจุบัน) → กรอกเฉพาะข้อมูลที่ทราบจริง → บันทึกเป็น CSV (UTF-8) → อัปโหลด → ตรวจสอบก่อนบันทึก. เซลล์ว่าง = ไม่เปลี่ยนค่าเดิม ระบบไม่เดาค่าให้ พนักงานจ้างเหมาไม่อยู่ในแบบฟอร์ม</p>
          <div class="ent-actions">
            <button type="button" class="btn" @click="download('profile', 'csv')">แบบฟอร์มข้อมูลบุคลากร (CSV)</button>
            <button type="button" class="btn" @click="download('profile', 'xlsx')">(Excel)</button>
            <button type="button" class="btn" @click="download('entitlement', 'csv')">แบบฟอร์มสิทธิ์วันลา ปี {{ fiscalYear }} (CSV)</button>
            <button type="button" class="btn" @click="download('entitlement', 'xlsx')">(Excel)</button>
          </div>
          <p v-if="downloadError" class="state state--error" role="alert">{{ downloadError }}</p>
          <div class="ent-line">
            <label class="field"><span>ไฟล์ข้อมูลบุคลากร (CSV)</span><input type="file" accept=".csv,text/csv" @change="pickFile('profile', $event)" /></label>
            <label class="field"><span>ไฟล์สิทธิ์วันลา (CSV)</span><input type="file" accept=".csv,text/csv" @change="pickFile('entitlement', $event)" /></label>
          </div>
          <div class="ent-actions">
            <button type="button" class="btn btn--primary" :disabled="importBusy || (!files.profile && !files.entitlement)" @click="runImport(false)">{{ importBusy ? 'กำลังตรวจสอบ…' : 'ตรวจสอบไฟล์ (ยังไม่บันทึก)' }}</button>
            <button type="button" class="btn" :disabled="importBusy || !canConfirm" @click="importConfirmOpen = true">ยืนยันนำเข้า</button>
          </div>
          <p v-if="importError" class="state state--error" role="alert">{{ importError }}</p>
          <template v-if="importResult">
            <p v-if="importResult.written" class="callout" role="status">นำเข้าแล้ว — {{ Object.entries(importResult.applied ?? {}).map(([k, v]) => `${fileLabel(k)} ${v.rowsApplied} แถว`).join(', ') }}</p>
            <p v-else-if="importResult.alreadyApplied" class="callout" role="status">ไฟล์นี้เคยนำเข้าแล้ว ไม่มีอะไรเปลี่ยนแปลง</p>
            <p v-else-if="importResult.blockingErrors > 0 || !importResult.ok" class="callout" role="alert">พบข้อผิดพลาด {{ importResult.blockingErrors }} จุด — ยังนำเข้าไม่ได้ แก้ไฟล์แล้วตรวจสอบอีกครั้ง</p>
            <p v-else class="callout" role="status">ตรวจสอบผ่าน — ยังไม่ได้บันทึกข้อมูล กด “ยืนยันนำเข้า” เพื่อบันทึก</p>
            <ul class="ent-findings">
              <li v-for="(f, kind) in importResult.files" :key="kind">{{ fileLabel(String(kind)) }}: {{ f?.rows }} แถว · จะบันทึก {{ f?.toApply }} · ไม่เปลี่ยนแปลง {{ f?.unchanged }}<template v-if="f?.alreadyApplied"> · นำเข้าแล้ว</template></li>
              <li v-for="g in findingGroups" :key="`${g.level}${g.kind}${g.code}`" :class="g.level === 'error' ? 'state--error' : 'muted'">
                {{ g.level === 'error' ? 'ผิดพลาด' : 'ข้อสังเกต' }} · {{ fileLabel(g.kind) }}: {{ findingLabelTh(g.code) }}<template v-if="g.lines.length"> (บรรทัด {{ g.lines.slice(0, 12).join(', ') }}{{ g.lines.length > 12 ? ' …' : '' }})</template>
              </li>
            </ul>
            <p v-if="importResult.findingsTruncated" class="muted">แสดงเฉพาะส่วนแรกของรายการ</p>
            <p v-if="importResult.preview" class="muted">ตัวอย่างผลของคนในไฟล์ ({{ importResult.preview.people }} คน): คำนวณได้
              <template v-for="t in LEAVE_KINDS" :key="t">{{ leaveTypeLabel(t) }} {{ importResult.preview.before[t]?.ok ?? 0 }} → {{ importResult.preview.after[t]?.ok ?? 0 }}; </template>
            </p>
          </template>
        </details>

        <div v-if="data.canEdit && selectedCount > 0" class="ent-bulkbar" role="status">
          <strong>เลือกแล้ว {{ selectedCount }} คน</strong>
          <button type="button" class="btn btn--primary" @click="openBulk">ยืนยันสิทธิ์ตามประกาศ…</button>
          <button type="button" class="btn btn--ghost" @click="selected = new Set()">ล้างที่เลือก</button>
        </div>
        <div v-else-if="data.canEdit && data.summary.unconfirmed > 0" class="ent-bulkbar">
          <span>มี {{ data.summary.unconfirmed }} คนรอยืนยันสิทธิ์ตามประกาศ</span>
          <button type="button" class="btn" @click="selectUnconfirmed">เลือกทั้งหมดที่รอยืนยัน</button>
        </div>

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
                <th v-if="data.canEdit" scope="col"><input type="checkbox" :checked="allVisibleSelected" aria-label="เลือกทั้งหมดที่แสดง" @change="toggleAllVisible" /></th>
                <th scope="col">พนักงาน</th>
                <th scope="col">สถานะ</th>
                <th v-for="t in LEAVE_KINDS" :key="t" scope="col">{{ leaveTypeLabel(t) }}</th>
                <th scope="col">ยกยอดพักผ่อน</th>
                <th v-if="data.canEdit" scope="col"><span class="sr-only">แก้ไข</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in visible" :key="row.employeeUid">
                <td v-if="data.canEdit"><input v-if="selectable(row)" type="checkbox" :checked="selected.has(row.employeeUid)" :aria-label="`เลือก ${row.name}`" @change="toggle(row.employeeUid)" /></td>
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
                <td v-if="data.canEdit"><button v-if="selectable(row)" type="button" class="btn btn--ghost" @click="openEdit(row)">กรอก/แก้ไข</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </AsyncState>

 <ConfirmDialog :open="bulkOpen" title="ยืนยันสิทธิ์ตามประกาศ" confirm-label="บันทึก" :busy="bulkBusy" @confirm="confirmBulk" @cancel="bulkOpen = false">
      <p>ผู้ที่เลือก {{ selectedCount }} คน (ไม่รวมพนักงานจ้างเหมา)</p>
      <label class="field">
        <span>การตัดสิน</span>
        <select v-model="bulkChoice">
          <option value="yes">อยู่ในประกาศ — ได้สิทธิ์ตามประกาศ</option>
          <option value="no">อยู่นอกประกาศ — ไม่ใช้เกณฑ์นี้</option>
          <option value="clear">ล้างการยืนยัน (กลับไปรอยืนยัน)</option>
        </select>
      </label>
      <label v-if="bulkChoice !== 'clear'" class="field">
        <span>อ้างอิงเอกสาร/เหตุผล (ไม่บังคับ)</span>
        <input v-model="bulkReference" type="text" maxlength="120" placeholder="เช่น คำสั่งที่ … (ถ้าเว้นว่าง ระบบบันทึกว่า ยืนยันโดยเจ้าของระบบ พร้อมวันที่)" />
      </label>
      <p v-if="bulkError" class="state state--error" role="alert">{{ bulkError }}</p>
    </ConfirmDialog>
    <ConfirmDialog :open="importConfirmOpen" title="ยืนยันนำเข้าข้อมูล" confirm-label="นำเข้า" :busy="importBusy" @confirm="runImport(true)" @cancel="importConfirmOpen = false">
      <p>บันทึกข้อมูลจากไฟล์ที่ตรวจสอบแล้วเข้าระบบ ทุกการเปลี่ยนแปลงมีประวัติ และนำเข้าไฟล์เดิมซ้ำจะไม่เกิดผลซ้ำ</p>
    </ConfirmDialog>
    <EntitlementEditDialog v-if="data" :row="editing" :fiscal-year-be="fiscalYear" :busy="saving" :error="saveError" @save="save" @cancel="editing = null" />
  </section>
</template>
