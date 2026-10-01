<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { AttendanceRecord } from '../api/types';
import { getStoredEmployee } from '../auth/session';
import AsyncState from '../components/AsyncState.vue';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const date = ref(todayIso());
const loading = ref(false);
const error = ref<string | null>(null);
const rows = ref<AttendanceRecord[]>([]);
const employee = getStoredEmployee();

async function load() {
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.attendanceDaily(date.value);
  } catch (e) {
    rows.value = [];
    error.value = e instanceof ApiError ? e.message : 'Failed to load daily attendance';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>Daily attendance</h2>
      <div class="inline-controls">
        <label class="field field--inline">
          <span>Date</span>
          <input v-model="date" type="date" />
        </label>
        <button type="button" class="btn btn--primary" :disabled="loading" @click="load">
          Load
        </button>
      </div>
    </div>
    <p class="muted">
      Signed in as <strong>{{ employee?.role }}</strong>. The API decides who can query
      <code>GET /api/v1/attendance/daily/:date</code>.
    </p>
    <AsyncState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      empty-message="No attendance records for this date."
    >
      <div v-if="rows.length" class="table-scroll">
        <table class="data-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Date</th>
            <th>Check in</th>
            <th>Check out</th>
            <th>Status</th>
            <th>Late (min)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="`${row.employeeUid}-${row.date}`">
            <td><code>{{ row.employeeUid.slice(0, 8) }}…</code></td>
            <td>{{ row.date }}</td>
            <td>{{ row.checkIn ?? '—' }}</td>
            <td>{{ row.checkOut ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td>{{ row.lateMinutes ?? '—' }}</td>
          </tr>
        </tbody>
        </table>
      </div>
    </AsyncState>
  </section>
</template>
