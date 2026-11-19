<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { EmployeePublic } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import { employeeStatusLabel, employeeTypeLabel, roleLabel } from '../utils/thai';

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
    error.value = e instanceof ApiError ? e.message : 'ไม่สามารถโหลดข้อมูลผู้ใช้ได้';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card">
    <div class="page-head">
      <h2>ข้อมูลของฉัน</h2>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">โหลดใหม่</button>
    </div>
    <AsyncState :loading="loading" :error="error" :empty="!profile" empty-message="ไม่พบข้อมูลผู้ใช้">
      <template v-if="profile">
        <dl class="detail-grid">
          <div><dt>ชื่อ-นามสกุล</dt><dd>{{ profile.firstNameTh }} {{ profile.lastNameTh }}</dd></div>
          <div><dt>รหัสพนักงาน</dt><dd>{{ profile.employeeId }}</dd></div>
          <div><dt>อีเมล</dt><dd>{{ profile.email }}</dd></div>
          <div><dt>หน่วยงาน</dt><dd>{{ profile.department }}</dd></div>
          <div><dt>ตำแหน่ง</dt><dd>{{ profile.position || '—' }}</dd></div>
          <div><dt>ประเภทบุคลากร</dt><dd>{{ employeeTypeLabel(profile.employeeType) }}</dd></div>
          <div><dt>สถานะ</dt><dd>{{ employeeStatusLabel(profile.status) }}</dd></div>
          <div><dt>บทบาทในระบบ</dt><dd>{{ roleLabel(profile.role) }}</dd></div>
        </dl>
        <details class="sys-details">
          <summary>ข้อมูลระบบ (สำหรับผู้ดูแล)</summary>
          <p>รหัสภายใน: <code>{{ profile.employeeUid }}</code></p>
        </details>
      </template>
    </AsyncState>
  </section>
</template>
