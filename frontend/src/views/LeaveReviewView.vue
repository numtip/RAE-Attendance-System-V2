<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { LeaveReviewList, LeaveReviewRow, ReviewBucket } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import PeriodPicker from '../components/PeriodPicker.vue';

const now = new Date();
const year = ref(now.getUTCFullYear());
const month = ref(now.getUTCMonth() + 1);
const loading = ref(false);
const error = ref<string | null>(null);
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null);
const data = ref<LeaveReviewList | null>(null);
const filter = ref<ReviewBucket>('needs_review');
const query = ref('');
const parts = ref<Record<string, 'FULL' | 'AM' | 'PM' | ''>>({});
const notes = ref<Record<string, string>>({});
const busy = ref<string | null>(null);
// Every decision (single or bulk) is confirmed explicitly in a dialog before anything is sent.
const pending = ref<{ rows: LeaveReviewRow[]; action: 'approve' | 'reject' } | null>(null);
const partLabels: Record<string, string> = { FULL: 'เต็มวัน (1.0)', AM: 'ครึ่งวันเช้า (0.5)', PM: 'ครึ่งวันบ่าย (0.5)' };
function ask(rows: LeaveReviewRow[], action: 'approve' | 'reject') {
  pending.value = { rows, action };
}
async function confirmPending() {
  const current = pending.value;
  if (!current) return;
  await send(current.rows, current.action);
  pending.value = null;
}

const tabs: { key: ReviewBucket; label: string }[] = [
  { key: 'needs_review', label: 'รอตรวจสอบ' },
  { key: 'unverified', label: 'ยังไม่ยืนยัน' },
  { key: 'approved', label: 'อนุมัติแล้ว' },
  { key: 'rejected', label: 'ไม่อนุมัติ' },
];

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return (data.value?.rows ?? []).filter((row) => !needle
    || (row.employeeId ?? '').toLowerCase().includes(needle) || (row.employeeName ?? '').toLowerCase().includes(needle));
});
// Bulk approval is offered only for ordinary candidates; an ambiguous record always needs its own decision.
const bulkTargets = computed(() => (filter.value === 'unverified' ? visible.value : []));

async function load() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await api.leaveReviewList(year.value, month.value, filter.value);
  } catch (e) {
    data.value = null;
    error.value = e instanceof ApiError && e.status === 403
      ? 'หน้านี้สำหรับผู้บริหารที่ได้รับสิทธิ์ระดับองค์กรเท่านั้น'
      : (e instanceof ApiError ? e.message : 'ไม่สามารถโหลดรายการได้');
  } finally {
    loading.value = false;
  }
}

function pick(next: ReviewBucket) {
  filter.value = next;
  void load();
}

async function send(rows: LeaveReviewRow[], action: 'approve' | 'reject') {
  notice.value = null;
  const decisions = rows.map((row) => ({
    recordUid: row.recordUid,
    action,
    ...(action === 'approve' && row.bucket === 'needs_review' && parts.value[row.recordUid] ? { dayPart: parts.value[row.recordUid] as 'FULL' | 'AM' | 'PM' } : {}),
    ...(notes.value[row.recordUid]?.trim() ? { note: notes.value[row.recordUid].trim() } : {}),
  }));
  busy.value = rows.length === 1 ? rows[0].recordUid : 'bulk';
  try {
    const result = await api.leaveReviewDecide(decisions);
    const firstError = result.results.find((r) => !r.ok)?.error;
    notice.value = result.failed
      ? { kind: 'error', text: `บันทึกสำเร็จ ${result.applied} รายการ, ไม่สำเร็จ ${result.failed}${firstError ? ` — ${firstError}` : ''}` }
      : { kind: 'ok', text: `บันทึกผลแล้ว ${result.applied} รายการ` };
    await load();
  } catch (e) {
    notice.value = { kind: 'error', text: e instanceof ApiError ? e.message : 'บันทึกไม่สำเร็จ' };
  } finally {
    busy.value = null;
  }
}

function needsPart(row: LeaveReviewRow): boolean {
  return row.bucket === 'needs_review' && !parts.value[row.recordUid];
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader
      eyebrow="ผู้บริหาร"
      title="ตรวจสอบ / อนุมัติการลา"
      subtitle="รายการลาที่บันทึกจากรายงาน HIP — ผู้บริหารเป็นผู้ยืนยันหรือปฏิเสธ ทุกการตัดสินถูกบันทึกประวัติ การอนุมัติไม่หักวันลาคงเหลือและไม่เปลี่ยนข้อมูลเข้างาน"
    />
    <PeriodPicker v-model:year="year" v-model:month="month" :loading="loading" submit-label="แสดงรายการ" @submit="load" />
    <p v-if="notice" class="callout" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

    <AsyncState :loading="loading" :error="error" :empty="false">
      <template v-if="data">
        <div class="seg" role="group" aria-label="กรองตามสถานะ">
          <button v-for="t in tabs" :key="t.key" type="button" class="seg-btn" :aria-pressed="filter === t.key" @click="pick(t.key)">
            {{ t.label }} ({{ data.counts[t.key] }})
          </button>
        </div>
        <div class="toolbar">
          <input v-model="query" class="search" type="search" placeholder="ค้นหาชื่อหรือรหัสพนักงาน" aria-label="ค้นหาชื่อหรือรหัสพนักงาน" />
          <span class="muted" aria-live="polite">{{ visible.length }} รายการ</span>
        </div>

        <div v-if="bulkTargets.length" class="bulk">
          <button type="button" class="btn" :disabled="busy !== null" @click="ask(bulkTargets, 'approve')">อนุมัติทั้งหมดที่แสดง ({{ bulkTargets.length }})</button>
        </div>

        <p v-if="visible.length === 0" class="state state--empty">ไม่มีรายการในสถานะนี้</p>
        <div v-else class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th class="sticky-col">พนักงาน</th><th>วันที่</th><th>ประเภท</th><th>ช่วงเวลา</th><th>สถานะ</th><th>การตัดสิน</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in visible" :key="row.recordUid">
                <td class="sticky-col">
                  <strong>{{ row.employeeName ?? 'ไม่พบข้อมูลพนักงาน' }}</strong><br />
                  <span class="muted">{{ row.employeeId }}</span>
                </td>
                <td>{{ row.dateLabel }}<br /><span class="muted">{{ row.source === 'owner' ? 'เจ้าของระบบระบุ' : 'HIP' }}</span></td>
                <td>{{ row.typeLabel }}</td>
                <td>
                  {{ row.partLabel }}<template v-if="row.dayFraction !== null"> · {{ row.dayFraction }} วัน</template>
                  <template v-if="row.reasonLabels.length"><br /><span class="muted">{{ row.reasonLabels.join('; ') }}</span></template>
                </td>
                <td>
                  <span class="chip" :class="row.bucket === 'approved' ? 'chip--ok' : row.bucket === 'rejected' ? 'chip--muted' : 'chip--late'">{{ row.bucket === 'needs_review' ? 'รอตรวจสอบ' : row.approvalLabel }}</span>
                  <template v-if="row.reviewedAt"><br /><span class="muted">{{ row.reviewedAt }}</span></template>
                </td>
                <td class="decide">
                  <label v-if="row.bucket === 'needs_review'" class="field">
                    <span class="sr-only">ช่วงเวลาที่ลาจริง</span>
                    <select :value="parts[row.recordUid] ?? ''" aria-label="ช่วงเวลาที่ลาจริง" @change="parts[row.recordUid] = ($event.target as HTMLSelectElement).value as 'FULL' | 'AM' | 'PM' | ''">
                      <option value="">เลือกช่วงเวลา…</option>
                      <option value="FULL">เต็มวัน (1.0)</option>
                      <option value="AM">ครึ่งวันเช้า (0.5)</option>
                      <option value="PM">ครึ่งวันบ่าย (0.5)</option>
                    </select>
                  </label>
                  <input v-model="notes[row.recordUid]" class="note" type="text" maxlength="200" placeholder="หมายเหตุ (ไม่บังคับ)" :aria-label="`หมายเหตุสำหรับ ${row.employeeName ?? ''}`" />
                  <span class="actions">
                    <button type="button" class="btn btn--primary" :disabled="busy !== null || needsPart(row) || row.bucket === 'approved'" @click="ask([row], 'approve')">อนุมัติ</button>
                    <button type="button" class="btn" :disabled="busy !== null || row.bucket === 'rejected'" @click="ask([row], 'reject')">ไม่อนุมัติ</button>
                  </span>
                  <span v-if="row.reviewNote" class="muted">หมายเหตุเดิม: {{ row.reviewNote }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </AsyncState>

    <ConfirmDialog
      :open="pending !== null"
      :title="pending?.action === 'reject' ? 'ยืนยันการไม่อนุมัติการลา' : 'ยืนยันการอนุมัติการลา'"
      :confirm-label="pending?.action === 'reject' ? 'ยืนยันไม่อนุมัติ' : 'ยืนยันอนุมัติ'"
      :busy="busy !== null"
      @cancel="pending = null"
      @confirm="confirmPending"
    >
      <template v-if="pending">
        <p v-if="pending.rows.length > 1">
          {{ pending.action === 'approve' ? 'อนุมัติ' : 'ไม่อนุมัติ' }} <strong>{{ pending.rows.length }} รายการ</strong>ที่แสดงอยู่
        </p>
        <dl v-else class="dialog-facts">
          <dt>พนักงาน</dt><dd>{{ pending.rows[0].employeeName ?? 'ไม่พบข้อมูลพนักงาน' }} ({{ pending.rows[0].employeeId }})</dd>
          <dt>วันที่</dt><dd>{{ pending.rows[0].dateLabel }}</dd>
          <dt>ประเภท</dt><dd>{{ pending.rows[0].typeLabel }}</dd>
          <dt>ช่วงเวลา</dt>
          <dd>{{ pending.action === 'approve' && parts[pending.rows[0].recordUid] ? partLabels[parts[pending.rows[0].recordUid]] : pending.rows[0].partLabel }}</dd>
          <template v-if="notes[pending.rows[0].recordUid]?.trim()"><dt>หมายเหตุ</dt><dd>{{ notes[pending.rows[0].recordUid] }}</dd></template>
        </dl>
        <p class="muted">การตัดสินจะถูกบันทึกประวัติ ไม่หักวันลาคงเหลือ และไม่เปลี่ยนข้อมูลเข้างาน</p>
      </template>
    </ConfirmDialog>
  </section>
</template>
