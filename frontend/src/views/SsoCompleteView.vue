<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiRequest } from '../api/client';
import { setSession } from '../auth/session';
import type { LoginEmployee } from '../api/types';

const route = useRoute();
const router = useRouter();
const errorMessage = ref('');

onMounted(async () => {
  const code = typeof route.query.code === 'string' ? route.query.code : '';
  if (!code) {
    errorMessage.value = 'ไม่พบรหัสเข้าสู่ระบบ SSO';
    await router.replace({ name: 'login', query: { error: 'sso_missing_code' } });
    return;
  }
  try {
    const data = await apiRequest<{
      accessToken: string;
      refreshToken: string;
      employee: LoginEmployee;
    }>('/auth/sso/exchange', {
      method: 'POST',
      body: { code },
      auth: false,
    });
    setSession(data.accessToken, data.refreshToken, data.employee);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '';
    await router.replace(redirect || { name: 'profile' });
  } catch {
    errorMessage.value = 'ไม่สามารถแลกรหัส SSO ได้';
    await router.replace({ name: 'login', query: { error: 'sso_exchange_failed' } });
  }
});
</script>

<template>
  <p v-if="errorMessage">{{ errorMessage }}</p>
  <p v-else>กำลังเข้าสู่ระบบ SSO…</p>
</template>
