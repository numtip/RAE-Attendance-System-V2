<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { LeaveBalanceRow } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';

const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');
const year = ref(new Date().getUTCFullYear());

const loading = ref(false);
const error = ref<string | null>(null);
const rows = ref<LeaveBalanceRow[]>([]);

async function load() {
  if (!employeeUid.value) {
    error.value = 'ไม่พบข้อมูลผู้ใช้ กรุณาเข้าสู่ระบบใหม่';
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.leaveBalance(employeeUid.value, year.value);
  } catch (e) {
    rows.value = [];
    error.value = e instanceof ApiError ? e.message : 'ไม่สามารถโหลดวันลาคงเหลือได้';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="page-head">
      <h2>วันลาคงเหลือ</h2>
      <form class="period" @submit.prevent="load">
        <label class="field">
          <span>ปี (ค.ศ.) <em class="field-hint">พ.ศ. {{ year + 543 }}</em></span>
          <input v-model.number="year" type="number" min="2000" max="2100" inputmode="numeric" />
        </label>
        <button type="submit" class="btn btn--primary" :disabled="loading">{{ loading ? 'กำลังโหลด…' : 'แสดงข้อมูล' }}</button>
      </form>
    </div>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="ไม่มีวันลาคงเหลือที่บันทึกไว้"
    >
      <div v-if="rows.length" class="table-scroll">
        <table class="data-table">
          <thead>
            <tr><th>ประเภท</th><th class="num">ทั้งหมด</th><th class="num">ใช้ไป</th><th class="num">คงเหลือ</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="`${row.leaveType}-${row.year}`">
              <td>{{ row.leaveType }}</td>
              <td class="num">{{ row.totalDays }}</td>
              <td class="num">{{ row.usedDays }}</td>
              <td class="num">{{ row.remainingDays }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </AsyncState>
  </section>
</template>
