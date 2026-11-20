<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../api/client';
import type { EmployeePublic } from '../api/types';
import AsyncState from '../components/AsyncState.vue';
import PageHeader from '../components/PageHeader.vue';
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

const initial = computed(() => (profile.value?.firstNameTh ?? '?').trim().charAt(0));

onMounted(load);
</script>

<template>
  <section>
    <PageHeader eyebrow="ข้อมูลส่วนตัว" title="ข้อมูลของฉัน" subtitle="ข้อมูลตามที่ลงทะเบียนไว้ในระบบ">
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">โหลดใหม่</button>
    </PageHeader>
    <AsyncState :loading="loading" :error="error" :empty="!profile" empty-message="ไม่พบข้อมูลผู้ใช้">
      <template v-if="profile">
        <div class="profile-hero">
          <span class="avatar" aria-hidden="true">{{ initial }}</span>
          <div>
            <h3>{{ profile.firstNameTh }} {{ profile.lastNameTh }}</h3>
            <p>{{ profile.position || profile.department }}</p>
            <div class="profile-meta">
              <span class="badge">{{ roleLabel(profile.role) }}</span>
              <span class="badge">{{ employeeStatusLabel(profile.status) }}</span>
            </div>
          </div>
        </div>
        <div class="card">
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
        </div>
      </template>
    </AsyncState>
  </section>
</template>
