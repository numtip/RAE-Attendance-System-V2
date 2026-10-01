<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { LeaveRow } from '../api/types';
import AsyncState from '../components/AsyncState.vue';

const loading = ref(true);
const error = ref<string | null>(null);
const rows = ref<LeaveRow[]>([]);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.leaveList();
  } catch (e) {
    rows.value = [];
    error.value = e instanceof ApiError ? e.message : 'Failed to load leave list';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>Leave list</h2>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">Refresh</button>
    </div>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="No leave requests."
    >
      <table v-if="rows.length" class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Type</th>
            <th>Start</th>
            <th>End</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.leaveId">
            <td>{{ row.leaveId }}</td>
            <td>{{ row.leaveType }}</td>
            <td>{{ row.startDate }}</td>
            <td>{{ row.endDate }}</td>
            <td>{{ row.status }}</td>
          </tr>
        </tbody>
      </table>
    </AsyncState>
  </section>
</template>
