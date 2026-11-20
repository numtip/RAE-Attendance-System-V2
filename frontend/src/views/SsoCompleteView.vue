<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import { setSession } from '../auth/session';

const route = useRoute();
const router = useRouter();
const statusMessage = ref('กำลังยืนยันการเข้าสู่ระบบด้วย MJU SSO…');

function safeRelativeRedirect(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return null;
  }
  return trimmed;
}

onMounted(async () => {
  const code = typeof route.query.code === 'string' ? route.query.code.trim() : '';
  if (!code) {
    statusMessage.value = 'ไม่พบรหัสยืนยันการเข้าสู่ระบบ SSO';
    await router.replace({ name: 'login', query: { error: 'sso_missing_code' } });
    return;
  }
  try {
    const data = await api.ssoExchange(code);
    setSession(data.accessToken, data.refreshToken, data.employee);
    const target = safeRelativeRedirect(route.query.redirect);
    if (target) {
      await router.replace(target);
      return;
    }
    await router.replace({ name: 'profile' });
  } catch {
    statusMessage.value = 'ไม่สามารถเข้าสู่ระบบด้วย MJU SSO ได้';
    await router.replace({ name: 'login', query: { error: 'sso_exchange_failed' } });
  }
});
</script>

<template>
  <div class="login-panel" style="min-height: 100vh">
    <section class="card login-card login-card--status" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <h1>MJU SSO</h1>
      <p class="muted">{{ statusMessage }}</p>
    </section>
  </div>
</template>
