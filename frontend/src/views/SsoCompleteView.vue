<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiRequest } from '../api/client';
import { setSession } from '../auth/session';
import type { LoginEmployee } from '../api/types';

const route = useRoute();
const router = useRouter();
const errorMessage = ref('');
const subject = ref('');
const subjectType = ref('');
const pending = ref(false);
const confirming = ref(false);

function handoffCode(): string {
  return typeof route.query.code === 'string' ? route.query.code : '';
}

onMounted(async () => {
  const code = handoffCode();
  if (!code) {
    errorMessage.value = 'ไม่พบรหัสเข้าสู่ระบบ SSO';
    await router.replace({ name: 'login', query: { error: 'sso_missing_code' } });
    return;
  }
  try {
    const data = await apiRequest<{
      confirmationRequired?: boolean;
      subject?: string;
      subjectType?: string;
      accessToken?: string;
    }>('/auth/sso/exchange', {
      method: 'POST',
      body: { code },
      auth: false,
    });
    if (data.confirmationRequired) {
      subject.value = data.subject || '';
      subjectType.value = data.subjectType || '';
      pending.value = true;
      return;
    }
    errorMessage.value = 'ต้องยืนยันก่อนเข้าสู่ระบบ';
  } catch {
    errorMessage.value = 'ไม่สามารถตรวจสอบรหัส SSO ได้';
    await router.replace({ name: 'login', query: { error: 'sso_exchange_failed' } });
  }
});

async function confirm() {
  const code = handoffCode();
  confirming.value = true;
  errorMessage.value = '';
  try {
    const data = await apiRequest<{
      accessToken: string;
      refreshToken: string;
      employee: LoginEmployee;
    }>('/auth/sso/exchange', {
      method: 'POST',
      body: { code, confirm: true },
      auth: false,
    });
    setSession(data.accessToken, data.refreshToken, data.employee);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '';
    await router.replace(redirect || { name: 'profile' });
  } catch {
    errorMessage.value = 'ไม่สามารถยืนยันการเข้าสู่ระบบ SSO ได้';
  } finally {
    confirming.value = false;
  }
}

async function cancel() {
  pending.value = false;
  await router.replace({ name: 'login', query: { error: 'sso_confirm_cancelled' } });
}
</script>

<template>
  <section v-if="pending">
    <h1>ยืนยันการเข้าสู่ระบบ SSO</h1>
    <p>รหัสผู้ใช้จาก MJU: {{ subject }}</p>
    <p v-if="subjectType">ชนิด: {{ subjectType }}</p>
    <p>
      การยืนยันนี้ไม่ได้พิสูจน์ว่ารหัสจากผู้ให้บริการถูกออกให้กับการเริ่มเข้าสู่ระบบครั้งนี้
      หากไม่ใช่บัญชีของคุณ ให้ยกเลิก
    </p>
    <button type="button" :disabled="confirming" @click="confirm">ยืนยันการเข้าสู่ระบบ</button>
    <button type="button" :disabled="confirming" @click="cancel">ยกเลิก</button>
    <p v-if="errorMessage">{{ errorMessage }}</p>
  </section>
  <p v-else-if="errorMessage">{{ errorMessage }}</p>
  <p v-else>กำลังตรวจสอบรหัส SSO…</p>
</template>
