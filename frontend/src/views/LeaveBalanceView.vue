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
    error.value = 'Missing employee context. Sign in again.';
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.leaveBalance(employeeUid.value, year.value);
  } catch (e) {
    rows.value = [];
    error.value = e instanceof ApiError ? e.message : 'Failed to load leave balance';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>Leave balance</h2>
      <div class="inline-controls">
        <label class="field field--inline">
          <span>Year</span>
          <input v-model.number="year" type="number" min="2000" max="2100" />
        </label>
        <button type="button" class="btn btn--primary" :disabled="loading" @click="load">Load</button>
      </div>
    </div>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="No balance rows for this year."
    >
      <table v-if="rows.length" class="data-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Total</th>
            <th>Used</th>
            <th>Remaining</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="`${row.leaveType}-${row.year}`">
            <td>{{ row.leaveType }}</td>
            <td>{{ row.totalDays }}</td>
            <td>{{ row.usedDays }}</td>
            <td>{{ row.remainingDays }}</td>
          </tr>
        </tbody>
      </table>
    </AsyncState>
  </section>
</template>
