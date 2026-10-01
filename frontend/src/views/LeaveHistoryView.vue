<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { LeaveRow } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';

const employeeUid = computed(() => getStoredEmployee()?.employeeUid ?? '');

const loading = ref(true);
const error = ref<string | null>(null);
const rows = ref<LeaveRow[]>([]);

async function load() {
  if (!employeeUid.value) {
    error.value = 'Missing employee context. Sign in again.';
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.leaveHistory(employeeUid.value);
  } catch (e) {
    rows.value = [];
    error.value = e instanceof ApiError ? e.message : 'Failed to load leave history';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>Leave history</h2>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">Refresh</button>
    </div>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="No leave history."
    >
      <div v-if="rows.length" class="table-scroll">
        <table class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Type</th>
            <th>Start</th>
            <th>End</th>
            <th>Status</th>
            <th>Match</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.leaveId">
            <td>{{ row.leaveId }}</td>
            <td>{{ row.leaveType }}</td>
            <td>{{ row.startDate }}</td>
            <td>{{ row.endDate }}</td>
            <td>{{ row.status }}</td>
            <td>{{ row.matchStatus ?? '—' }}</td>
          </tr>
        </tbody>
        </table>
      </div>
    </AsyncState>
  </section>
</template>
