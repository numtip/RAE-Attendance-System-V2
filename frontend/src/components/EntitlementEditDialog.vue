<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { EntitlementFactsInput, EntitlementProfile, EntitlementRow, LeaveKind } from '../api/types';
import { APPOINTMENT_KIND_TH, LEAVE_KINDS, missingLabelTh, parseDaysInput } from '../utils/leaveEntitlement';
import { leaveTypeLabel } from '../utils/i18n';
import ThaiDateInput from './ThaiDateInput.vue';

// The owner's data entry for ONE person. It sends only what changed: an untouched field is not sent (the server
// leaves it alone), a field the owner cleared is sent as null, and nothing is ever pre-filled with a guess.
const props = defineProps<{ row: EntitlementRow | null; fiscalYearBe: number; busy: boolean; error: string | null }>();
const emit = defineEmits<{ save: [body: EntitlementFactsInput]; cancel: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const todayIso = new Date().toISOString().slice(0, 10);

const hasHire = ref(false);
const hire = ref(todayIso);
const hasContinuous = ref(false);
const continuous = ref(todayIso);
const kind = ref<string>('');
const eligibility = ref<'' | 'yes' | 'no'>('');
const reference = ref('');
const days = ref<Record<LeaveKind, string>>({ sick: '', personal: '', vacation: '' });
const carryover = ref('');
const remove = ref<Record<LeaveKind, boolean>>({ sick: false, personal: false, vacation: false });
const localError = ref<string | null>(null);

const initial = computed<EntitlementProfile>(() => props.row?.profile ?? {
  hireDate: null, continuousServiceStart: null, appointmentKind: null, eligibilityConfirmed: null, eligibilityReference: null,
});

watch(() => props.row, async (row) => {
  const el = dialog.value;
  if (!el) return;
  if (!row) { if (el.open) el.close(); return; }
  const p = row.profile;
  hasHire.value = Boolean(p?.hireDate); hire.value = p?.hireDate ?? todayIso;
  hasContinuous.value = Boolean(p?.continuousServiceStart); continuous.value = p?.continuousServiceStart ?? todayIso;
  kind.value = p?.appointmentKind ?? '';
  eligibility.value = p?.eligibilityConfirmed === true ? 'yes' : (p?.eligibilityConfirmed === false ? 'no' : '');
  reference.value = p?.eligibilityReference ?? '';
  // Only a figure the owner entered earlier (source hr_verified) is pre-filled; a computed policy value is a hint, not a value.
  for (const t of LEAVE_KINDS) {
    const cell = row.types[t];
    days.value[t] = cell?.source === 'hr_verified' && cell.entitlementDays !== null ? String(cell.entitlementDays) : '';
    remove.value[t] = false;
  }
  const vac = row.types.vacation;
  carryover.value = vac?.source === 'hr_verified' && vac.carryoverDays !== null ? String(vac.carryoverDays) : '';
  localError.value = null;
  if (!el.open) { el.showModal(); await nextTick(); }
});

function policyHint(t: LeaveKind): string | null {
  const cell = props.row?.types[t];
  return cell && cell.source === 'computed' && cell.entitlementDays !== null ? `ตามประกาศ ${cell.entitlementDays} วัน` : null;
}
const storedOverride = (t: LeaveKind) => props.row?.types[t]?.source === 'hr_verified';

function submit() {
  localError.value = null;
  const body: EntitlementFactsInput = {};
  const p = initial.value;
  const hireValue = hasHire.value ? hire.value : null;
  if (hireValue !== p.hireDate) body.hireDate = hireValue;
  const contValue = hasContinuous.value ? continuous.value : null;
  if (contValue !== p.continuousServiceStart) body.continuousServiceStart = contValue;
  const kindValue = (kind.value || null) as EntitlementProfile['appointmentKind'];
  if (kindValue !== p.appointmentKind) body.appointmentKind = kindValue;
  const elig = eligibility.value === 'yes' ? true : (eligibility.value === 'no' ? false : null);
  const refValue = reference.value.trim();
  if (elig !== p.eligibilityConfirmed || (elig !== null && refValue !== (p.eligibilityReference ?? ''))) {
    body.eligibility = elig === null ? { confirmed: null } : { confirmed: elig, ...(refValue ? { reference: refValue } : {}) };
  }
  const rows: NonNullable<EntitlementFactsInput['entitlements']> = [];
  for (const t of LEAVE_KINDS) {
    if (remove.value[t] && storedOverride(t)) { rows.push({ fiscalYearBe: props.fiscalYearBe, leaveType: t, remove: true }); continue; }
    const d = parseDaysInput(days.value[t], 120);
    if (d === 'invalid') { localError.value = `จำนวนวันของ${leaveTypeLabel(t)}ต้องเป็นตัวเลขหลายเท่าของ 0.5`; return; }
    const c = t === 'vacation' ? parseDaysInput(carryover.value, 30) : null;
    if (c === 'invalid') { localError.value = 'วันลาพักผ่อนสะสมต้องเป็นตัวเลขหลายเท่าของ 0.5 ไม่เกิน 30'; return; }
    if (d === null) {
      if (t === 'vacation' && c !== null) { localError.value = 'กรอกสิทธิ์ลาพักผ่อนของปีนี้ด้วย จึงจะบันทึกวันสะสมได้'; return; }
      continue;
    }
    const cell = props.row?.types[t];
    const unchanged = storedOverride(t) && cell?.entitlementDays === d && (t !== 'vacation' || (cell?.carryoverDays ?? null) === c);
    if (!unchanged) rows.push({ fiscalYearBe: props.fiscalYearBe, leaveType: t, entitlementDays: d, ...(t === 'vacation' ? { carryoverDays: c } : {}) });
  }
  if (rows.length) body.entitlements = rows;
  if (Object.keys(body).length === 0) { localError.value = 'ยังไม่มีการเปลี่ยนแปลง'; return; }
  emit('save', body);
}
function onClose() { if (props.row) emit('cancel'); }
function onBackdrop(e: MouseEvent) { if (e.target === dialog.value && !props.busy) emit('cancel'); }
</script>

<template>
  <dialog ref="dialog" class="dialog dialog--form" aria-labelledby="ent-edit-title" @close="onClose" @click="onBackdrop">
    <form v-if="row" class="dialog-body" @submit.prevent="submit">
      <h3 id="ent-edit-title">กรอกข้อมูลสิทธิ์วันลา</h3>
      <p class="muted">{{ row.name }} · {{ row.employeeId }} · ปีงบประมาณ {{ fiscalYearBe }}</p>
      <p v-if="row.missing.length" class="callout" role="note">ยังขาด: {{ row.missing.map(missingLabelTh).join(', ') }}</p>
      <p class="muted">เว้นว่างไว้หากยังไม่ทราบ — ระบบจะไม่เดาค่าให้ และทุกการแก้ไขถูกบันทึกประวัติ</p>

      <fieldset class="ent-group">
        <legend>ข้อมูลการจ้างงาน</legend>
        <label class="field field--inline"><input v-model="hasHire" type="checkbox" /> <span>ทราบวันที่เริ่มจ้าง</span></label>
        <ThaiDateInput v-if="hasHire" v-model="hire" label="วันที่เริ่มจ้าง" :span="45" />
        <label class="field field--inline"><input v-model="hasContinuous" type="checkbox" /> <span>ทราบวันที่เริ่มนับอายุงานต่อเนื่อง</span></label>
        <ThaiDateInput v-if="hasContinuous" v-model="continuous" label="เริ่มนับอายุงานต่อเนื่อง" :span="45" />
        <label class="field">
          <span>ลักษณะการบรรจุ</span>
          <select v-model="kind">
            <option value="">ไม่ระบุ</option>
            <option v-for="(label, key) in APPOINTMENT_KIND_TH" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
      </fieldset>

      <fieldset class="ent-group">
        <legend>การยืนยันสิทธิ์ตามประกาศ</legend>
        <label class="field">
          <span>การตัดสิน</span>
          <select v-model="eligibility">
            <option value="">ยังไม่ยืนยัน (ใช้ประเภทบุคลากรตามเดิม)</option>
            <option value="yes">อยู่ในประกาศ — ได้สิทธิ์ตามประกาศ</option>
            <option value="no">อยู่นอกประกาศ — ไม่ใช้เกณฑ์นี้</option>
          </select>
        </label>
        <label v-if="eligibility" class="field">
          <span>อ้างอิงเอกสาร/เหตุผล (ไม่บังคับ)</span>
          <input v-model="reference" type="text" maxlength="120" placeholder="เช่น คำสั่งที่ …" />
        </label>
      </fieldset>

      <fieldset class="ent-group">
        <legend>สิทธิ์วันลาของปีงบประมาณ {{ fiscalYearBe }} (กรอกเมื่อต้องการกำหนดเอง)</legend>
        <div v-for="t in LEAVE_KINDS" :key="t" class="ent-line">
          <label class="field">
            <span>{{ leaveTypeLabel(t) }} (วัน)</span>
            <input v-model="days[t]" type="text" inputmode="decimal" :placeholder="policyHint(t) ?? 'ไม่ระบุ'" />
          </label>
          <label v-if="t === 'vacation'" class="field">
            <span>วันสะสมยกมา (วัน)</span>
            <input v-model="carryover" type="text" inputmode="decimal" placeholder="0 = ไม่มี, เว้นว่าง = ไม่ทราบ" />
          </label>
          <label v-if="storedOverride(t)" class="field field--inline"><input v-model="remove[t]" type="checkbox" /> <span>ลบค่าที่กำหนดเอง</span></label>
        </div>
      </fieldset>

      <p v-if="localError || error" class="state state--error" role="alert">{{ localError || error }}</p>
      <div class="dialog-actions">
        <button type="button" class="btn" :disabled="busy" @click="emit('cancel')">ยกเลิก</button>
        <button type="submit" class="btn btn--primary" :disabled="busy">{{ busy ? 'กำลังบันทึก…' : 'บันทึก' }}</button>
      </div>
    </form>
  </dialog>
</template>
