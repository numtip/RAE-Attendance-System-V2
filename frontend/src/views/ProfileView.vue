<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { EmployeePublic } from '../api/types';
import AsyncState from '../components/AsyncState.vue';

const loading = ref(true);
const error = ref<string | null>(null);
const profile = ref<EmployeePublic | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    profile.value = await api.me();
  } catch (e) {
    profile.value = null;
    error.value = e instanceof ApiError ? e.message : 'Failed to load profile';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>Current user</h2>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">Refresh</button>
    </div>
    <AsyncState :loading="loading" :error="error" :empty="!profile" empty-message="Profile not available.">
      <dl v-if="profile" class="detail-grid">
        <div><dt>Name</dt><dd>{{ profile.firstNameTh }} {{ profile.lastNameTh }}</dd></div>
        <div><dt>Employee ID</dt><dd>{{ profile.employeeId }}</dd></div>
        <div><dt>Email</dt><dd>{{ profile.email }}</dd></div>
        <div><dt>Department</dt><dd>{{ profile.department }}</dd></div>
        <div><dt>Position</dt><dd>{{ profile.position }}</dd></div>
        <div><dt>Type</dt><dd>{{ profile.employeeType }}</dd></div>
        <div><dt>Status</dt><dd>{{ profile.status }}</dd></div>
        <div><dt>Role</dt><dd>{{ profile.role }}</dd></div>
        <div><dt>UID</dt><dd><code>{{ profile.employeeUid }}</code></dd></div>
      </dl>
    </AsyncState>
  </section>
</template>
