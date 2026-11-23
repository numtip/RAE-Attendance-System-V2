<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { EntitlementFactsInput, EntitlementProfile, EntitlementRow, LeaveKind } from '../api/types';
import { APPOINTMENT_KIND_TH, LEAVE_KINDS, missingLabelTh, parseDaysInput, policyLabelTh } from '../utils/leaveEntitlement';
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
// Days already used BEFORE the system began counting (outside the leave records), and the date they cover up to.
const baseDays = ref<Record<LeaveKind, string>>({ sick: '', personal: '', vacation: '' });
const hasBaseDate = ref<Record<LeaveKind, boolean>>({ sick: false, personal: false, vacation: false });
const baseDate = ref<Record<LeaveKind, string>>({ sick: todayIso, personal: todayIso, vacation: todayIso });
const remove = ref<Record<LeaveKind, boolean>>({ sick: false, personal: false, vacation: false });
const localError = ref<string | null>(null);

// What this person's policy needs. A field the policy does not use is not shown, so it can never be asked for.
const requires = computed(() => props.row?.policy?.requires ?? null);
const showHire = computed(() => (requires.value?.hireDateFor.length ?? 0) > 0);
const showContinuity = computed(() => Boolean(requires.value?.continuousService));
const showKind = computed(() => Boolean(requires.value?.appointmentKind));
const showCarryover = computed(() => Boolean(requires.value?.carryover));
const unmapped = computed(() => props.row?.policy?.family === null);
const hireNote = computed(() => (requires.value?.hireDateFor ?? []).map((t) => leaveTypeLabel(t)).join(' และ '));
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
  for (const t of LEAVE_KINDS) {
    const st = row.stored?.[t];
    baseDays.value[t] = st?.usageBaselineDays != null ? String(st.usageBaselineDays) : '';
    hasBaseDate.value[t] = Boolean(st?.usageBaselineThrough);
    baseDate.value[t] = st?.usageBaselineThrough ?? clampToYear(todayIso);
  }
  const vac = row.types.vacation;
  carryover.value = vac?.source === 'hr_verified' && vac.carryoverDays !== null ? String(vac.carryoverDays) : '';
  localError.value = null;
  if (!el.open) { el.showModal(); await nextTick(); }
});

// A baseline date must lie inside the fiscal year: start the picker on a date that does.
function clampToYear(iso: string): string {
  const start = `${props.fiscalYearBe - 544}-10-01`;
  const end = `${props.fiscalYearBe - 543}-09-30`;
  return iso < start ? start : (iso > end ? end : iso);
}
function policyHint(t: LeaveKind): string | null {
  const cell = props.row?.types[t];
  return cell && cell.source === 'computed' && cell.entitlementDays !== null ? `ตามหลักเกณฑ์ ${cell.entitlementDays} วัน` : null;
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
    const c = t === 'vacation' && showCarryover.value ? parseDaysInput(carryover.value, 30) : null;
    if (c === 'invalid') { localError.value = 'วันลาพักผ่อนสะสมต้องเป็นตัวเลขหลายเท่าของ 0.5 ไม่เกิน 30'; return; }
    const cell = props.row?.types[t];
    const st = props.row?.stored?.[t];
    const bDays = parseDaysInput(baseDays.value[t], 120);
    if (bDays === 'invalid') { localError.value = `จำนวนวันที่ใช้ไปก่อนเริ่มนับของ${leaveTypeLabel(t)}ต้องเป็นตัวเลขหลายเท่าของ 0.5`; return; }
    if ((bDays !== null) !== hasBaseDate.value[t]) { localError.value = `${leaveTypeLabel(t)}: จำนวนวันที่ใช้ไปก่อนเริ่มนับต้องกรอกคู่กับ “นับถึงวันที่”`; return; }
    const bThrough = hasBaseDate.value[t] ? baseDate.value[t] : null;
    if (d === null) {
      if (bDays !== null || (t === 'vacation' && c !== null)) {
        const hint = policyHint(t);
        localError.value = `${leaveTypeLabel(t)}: ต้องกรอกสิทธิ์ของปีนี้ด้วย${hint ? ` (${hint})` : ''} จึงจะบันทึกวันสะสมหรือวันที่ใช้ไปก่อนเริ่มนับได้`;
        return;
      }
      continue;
    }
    const unchanged = storedOverride(t) && cell?.entitlementDays === d
      && (t !== 'vacation' || (cell?.carryoverDays ?? null) === c)
      && (st?.usageBaselineDays ?? null) === bDays && (st?.usageBaselineThrough ?? null) === bThrough;
    if (!unchanged) {
      rows.push({
        fiscalYearBe: props.fiscalYearBe, leaveType: t, entitlementDays: d,
        ...(t === 'vacation' ? { carryoverDays: c } : {}), usageBaselineDays: bDays, usageBaselineThrough: bThrough,
      });
    }
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
      <p class="muted">หลักเกณฑ์: <strong>{{ policyLabelTh(row.policy) }}</strong><template v-if="unmapped"> — ยังไม่ได้ระบุว่าประเภทนี้ใช้หลักเกณฑ์ใด: เมื่อยืนยันสิทธิ์ ระบบใช้เกณฑ์ของพนักงานมหาวิทยาลัยเหมือนเดิม (และแสดงหมายเหตุกำกับ)</template></p>
      <p v-if="row.missing.length" class="callout" role="note">ยังขาด: {{ row.missing.map(missingLabelTh).join(', ') }}</p>
      <p class="muted">เว้นว่างไว้หากยังไม่ทราบ — ระบบจะไม่เดาค่าให้ และทุกการแก้ไขถูกบันทึกประวัติ</p>

      <fieldset v-if="showHire || showContinuity || showKind" class="ent-group">
        <legend>ข้อมูลการจ้างงาน</legend>
        <template v-if="showHire">
          <label class="field field--inline"><input v-model="hasHire" type="checkbox" /> <span>ทราบวันที่เริ่มจ้าง (ใช้คำนวณ{{ hireNote }})</span></label>
          <ThaiDateInput v-if="hasHire" v-model="hire" label="วันที่เริ่มจ้าง" :span="45" />
        </template>
        <template v-if="showContinuity">
          <label class="field field--inline"><input v-model="hasContinuous" type="checkbox" /> <span>ทราบวันที่เริ่มนับอายุงานต่อเนื่อง</span></label>
          <ThaiDateInput v-if="hasContinuous" v-model="continuous" label="เริ่มนับอายุงานต่อเนื่อง" :span="45" />
        </template>
        <label v-if="showKind" class="field">
          <span>ลักษณะการบรรจุ</span>
          <select v-model="kind">
            <option value="">ไม่ระบุ</option>
            <option v-for="(label, key) in APPOINTMENT_KIND_TH" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
      </fieldset>
      <p v-else class="muted">หลักเกณฑ์นี้ไม่ต้องใช้วันที่เริ่มงาน อายุงานต่อเนื่อง หรือลักษณะการบรรจุ</p>

      <fieldset class="ent-group">
        <legend>การยืนยันสิทธิ์ตามหลักเกณฑ์</legend>
        <label class="field">
          <span>การตัดสิน</span>
          <select v-model="eligibility">
            <option value="">ยังไม่ยืนยัน (ใช้ประเภทบุคลากรตามเดิม)</option>
            <option value="yes">อยู่ในหลักเกณฑ์ — ได้สิทธิ์ตามหลักเกณฑ์ของตน</option>
            <option value="no">อยู่นอกหลักเกณฑ์ — ไม่คำนวณสิทธิ์</option>
          </select>
        </label>
        <label v-if="eligibility" class="field">
          <span>อ้างอิงเอกสาร/เหตุผล (ไม่บังคับ)</span>
          <input v-model="reference" type="text" maxlength="120" placeholder="เช่น คำสั่งที่ …" />
        </label>
      </fieldset>

      <fieldset class="ent-group">
        <legend>สิทธิ์วันลาของปีงบประมาณ {{ fiscalYearBe }} (กรอกเมื่อต้องการกำหนดเอง)</legend>
        <p class="muted">“ใช้ไปแล้วก่อนเริ่มนับ” คือวันลาที่ใช้ไปแล้วแต่ยังไม่อยู่ในรายการลาของระบบ นับถึงวันที่ระบุ — ถ้าไม่ทราบให้เว้นว่าง ระบบจะไม่เดาให้</p>
        <div v-for="t in LEAVE_KINDS" :key="t" class="ent-line">
          <label class="field">
            <span>{{ leaveTypeLabel(t) }} (วัน)</span>
            <input v-model="days[t]" type="text" inputmode="decimal" :placeholder="policyHint(t) ?? 'ไม่ระบุ'" />
          </label>
          <label v-if="t === 'vacation' && showCarryover" class="field">
            <span>วันสะสมยกมา (วัน)</span>
            <input v-model="carryover" type="text" inputmode="decimal" placeholder="0 = ไม่มี, เว้นว่าง = ไม่ทราบ" />
          </label>
          <p v-if="row.types[t]?.missing.length" class="muted ent-line-note">ขาด: {{ row.types[t]!.missing.map(missingLabelTh).join(', ') }}</p>
          <label class="field">
            <span>ใช้ไปแล้วก่อนเริ่มนับในระบบ (วัน)</span>
            <input v-model="baseDays[t]" type="text" inputmode="decimal" placeholder="เว้นว่าง = ไม่ทราบ" />
          </label>
          <div class="ent-baseline-date">
            <label class="field field--inline"><input v-model="hasBaseDate[t]" type="checkbox" /> <span>นับถึงวันที่</span></label>
            <ThaiDateInput v-if="hasBaseDate[t]" v-model="baseDate[t]" label="นับถึงวันที่" :span="2" />
          </div>
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
