<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { apiRequest } from '../api/client';
import { errorMessageTh } from '../utils/i18n';
interface Holiday { id: number; date: string; name: string; status: 'approved' | 'candidate'; sourceReference: string }
const props = defineProps<{ year: number }>();
const emit = defineEmits<{ changed: [] }>();
const rows = ref<Holiday[]>([]);
const id = ref<number | null>(null);
const date = ref(''); const name = ref(''); const source = ref('');
const status = ref<'approved' | 'candidate'>('candidate');
const busy = ref(false); const error = ref('');
const notice = ref('');
async function load() {
  try { rows.value = await apiRequest<Holiday[]>(`/attendance/holidays?year=${props.year}`); }
  catch (e) { error.value = errorMessageTh(e, 'โหลดวันหยุดไม่สำเร็จ'); }
}
function clear() { id.value = null; date.value = ''; name.value = ''; source.value = ''; status.value = 'candidate'; }
function edit(row: Holiday) { id.value = row.id; date.value = row.date; name.value = row.name; source.value = row.sourceReference || ''; status.value = row.status; }
async function save() {
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await apiRequest<{ protectedSummaries: number }>(id.value ? `/attendance/holidays/${id.value}` : '/attendance/holidays', {
      method: id.value ? 'PUT' : 'POST', body: { date: date.value, name: name.value, sourceReference: source.value, status: status.value },
    });
    if (result.protectedSummaries) notice.value = `เก็บยอดสรุปเดิม ${result.protectedSummaries} รายการที่ข้อมูลรายวันไม่ตรงกัน กรุณาตรวจสอบ`;
    clear(); await load(); emit('changed');
  } catch (e) { error.value = errorMessageTh(e, 'บันทึกวันหยุดไม่สำเร็จ'); }
  finally { busy.value = false; }
}
async function remove(row: Holiday) {
  if (!window.confirm(`ลบวันหยุด ${row.name} วันที่ ${row.date} หรือไม่`)) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { const result = await apiRequest<{ protectedSummaries: number }>(`/attendance/holidays/${row.id}`, { method: 'DELETE' }); if (result.protectedSummaries) notice.value = `เก็บยอดสรุปเดิม ${result.protectedSummaries} รายการที่ข้อมูลรายวันไม่ตรงกัน กรุณาตรวจสอบ`; clear(); await load(); emit('changed'); }
  catch (e) { error.value = errorMessageTh(e, 'ลบวันหยุดไม่สำเร็จ'); }
  finally { busy.value = false; }
}
async function recalculate() {
  if (!window.confirm(`คำนวณข้อมูลการเข้างานปี ${props.year + 543} ใหม่ตามวันหยุดที่อนุมัติหรือไม่`)) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { const result = await apiRequest<{ protectedSummaries: number }>('/attendance/holidays/recalculate', { method: 'POST', body: { year: props.year } }); if (result.protectedSummaries) notice.value = `เก็บยอดสรุปเดิม ${result.protectedSummaries} รายการที่ข้อมูลรายวันไม่ตรงกัน กรุณาตรวจสอบ`; emit('changed'); }
  catch (e) { error.value = errorMessageTh(e, 'คำนวณข้อมูลใหม่ไม่สำเร็จ'); }
  finally { busy.value = false; }
}
onMounted(load); watch(() => props.year, load);
</script>
<template>
  <details class="card">
    <summary>จัดการวันหยุด</summary>
    <p>วันหยุดที่อนุมัติใช้คำนวณการเข้างาน ส่วนรายการรอตรวจสอบยังไม่มีผล</p>
    <button type="button" class="btn" :disabled="busy" @click="recalculate">คำนวณข้อมูลปีนี้ใหม่</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>วันที่</th><th>วันหยุด</th><th>สถานะ</th><th>แหล่งอ้างอิง</th><th>จัดการ</th></tr></thead>
      <tbody><tr v-for="row in rows" :key="row.id"><td>{{ row.date }}</td><td>{{ row.name }}</td><td>{{ row.status === 'approved' ? 'อนุมัติ' : 'รอตรวจสอบ' }}</td>
        <td><a :href="row.sourceReference" target="_blank" rel="noopener noreferrer">แหล่งข้อมูล</a></td>
        <td><button type="button" :disabled="busy" @click="edit(row)">แก้ไข</button> <button type="button" :disabled="busy" @click="remove(row)">ลบ</button></td></tr></tbody></table></div>
    <form @submit.prevent="save">
      <label>วันที่ <input v-model="date" type="date" required /></label>
      <label>ชื่อวันหยุด <input v-model="name" maxlength="255" required /></label>
      <label>แหล่งอ้างอิง <input v-model="source" type="url" maxlength="255" placeholder="https://" required /></label>
      <label>สถานะ <select v-model="status"><option value="candidate">รอตรวจสอบ</option><option value="approved">อนุมัติ</option></select></label>
      <button class="btn btn--primary" :disabled="busy" type="submit">{{ id ? 'บันทึกการแก้ไข' : 'เพิ่มวันหยุด' }}</button>
      <button v-if="id" class="btn" type="button" @click="clear">ยกเลิก</button>
    </form>
  </details>
</template>
