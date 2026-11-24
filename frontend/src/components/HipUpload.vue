<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiRequest, ApiError } from '../api/client';
import { errorMessageTh } from '../utils/i18n';

interface Preview { contentSha256: string; scanRows: number; alreadyImported: number; newResolved: number; newUnmapped: number; dateFrom: string | null; dateTo: string | null }
interface Batch { id: string; status: string; rowCount: number; insertedCount: number; duplicateCount: number; unmappedCount: number; startedAt: string }
interface Imported { complete: boolean; rows: Record<string, number>; derive: { employeeDays: number; outcomes: Record<string, number> } | null }
const emit = defineEmits<{ imported: [] }>();
const csv = ref('');
const preview = ref<Preview | null>(null);
const history = ref<Batch[]>([]);
const result = ref<Imported | null>(null);
const error = ref('');
const busy = ref(false);
async function loadHistory() {
  history.value = await apiRequest<Batch[]>('/attendance/hip/history');
}
async function selectFile(event: Event) {
  preview.value = null; result.value = null; error.value = ''; csv.value = '';
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.csv') || file.size > 8 * 1024 * 1024) { error.value = 'โปรดเลือกไฟล์ CSV ขนาดไม่เกิน 8 MB'; return; }
  try { csv.value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { error.value = 'ไฟล์ต้องเข้ารหัส UTF-8'; }
}
async function inspect() {
  busy.value = true; error.value = ''; result.value = null;
  try { preview.value = await apiRequest<Preview>('/attendance/hip/preview', { method: 'POST', body: { csv: csv.value } }); }
  catch (e) {
    const details = e instanceof ApiError ? e.details as { rejectedRows?: number | null } | undefined : undefined;
    error.value = details?.rejectedRows != null
      ? `ไฟล์ไม่ผ่านการตรวจสอบ พบ ${details.rejectedRows} แถวที่ไม่ถูกต้อง จึงไม่ได้นำเข้าทั้งไฟล์`
      : errorMessageTh(e, 'ไม่สามารถตรวจสอบไฟล์ได้ กรุณาตรวจสอบรูปแบบ CSV');
  }
  finally { busy.value = false; }
}
async function confirmImport() {
  if (!preview.value) return;
  busy.value = true; error.value = '';
  try {
    result.value = await apiRequest<Imported>('/attendance/hip/import', { method: 'POST', body: { csv: csv.value, contentSha256: preview.value.contentSha256, confirm: true } });
    preview.value = null;
    emit('imported');
    await loadHistory();
  } catch (e) { error.value = errorMessageTh(e, 'นำเข้าข้อมูลไม่สำเร็จ'); }
  finally { busy.value = false; }
}
onMounted(() => { loadHistory().catch((e) => { error.value = errorMessageTh(e, 'ไม่สามารถโหลดประวัติได้'); }); });
</script>

<template>
  <details class="card">
    <summary>อัปโหลดข้อมูล HIP</summary>
    <p>เลือกไฟล์รายงาน HIP แบบ CSV (UTF-8) แล้วตรวจสอบก่อนยืนยัน</p>
    <input type="file" accept=".csv,text/csv" :disabled="busy" @change="selectFile" />
    <button type="button" class="btn" :disabled="!csv || busy" @click="inspect">ตรวจสอบก่อนนำเข้า</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="preview">
      <p>ช่วง {{ preview.dateFrom }} – {{ preview.dateTo }} · สแกน {{ preview.scanRows }} · ใหม่ {{ preview.newResolved }} · ซ้ำ {{ preview.alreadyImported }} · ไม่พบรหัสบุคลากร {{ preview.newUnmapped }} · ปฏิเสธ 0</p>
      <button type="button" class="btn btn--primary" :disabled="busy" @click="confirmImport">ยืนยันนำเข้า</button>
    </div>
    <div v-if="result" role="status">
      <p>{{ result.complete ? 'นำเข้าและคำนวณแล้ว' : 'นำเข้าแล้ว แต่คำนวณไม่ครบ กรุณานำเข้าไฟล์เดิมอีกครั้ง' }} · นำเข้า {{ (result.rows.resolved || 0) + (result.rows.unmapped || 0) }} · ซ้ำ {{ result.rows.duplicate || 0 }} · ไม่พบรหัส {{ result.rows.unmapped || 0 }} · ปฏิเสธ 0</p>
    </div>
    <h4>ประวัติการนำเข้า</h4>
    <p v-if="!history.length">ยังไม่มีประวัติ</p>
    <div v-else class="table-scroll"><table class="data-table"><thead><tr><th>เวลา</th><th>สถานะ</th><th>นำเข้า</th><th>ซ้ำ</th><th>ไม่พบรหัส</th></tr></thead>
      <tbody><tr v-for="batch in history" :key="batch.id"><td>{{ new Date(batch.startedAt).toLocaleString('th-TH') }}</td><td>{{ batch.status }}</td><td>{{ batch.insertedCount }}</td><td>{{ batch.duplicateCount }}</td><td>{{ batch.unmappedCount }}</td></tr></tbody></table></div>
  </details>
</template>
