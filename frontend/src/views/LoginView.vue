<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '../api/client';
import { setSession } from '../auth/session';
import { isReviewFixtureMode, reviewModeBannerText } from '../config/reviewMode';

const route = useRoute();
const router = useRouter();

const email = ref('user@example.test');
const password = ref('valid-pass');
const loading = ref(false);
const error = ref<string | null>(null);

const SSO_ERROR_MESSAGES: Record<string, string> = {
  sso_missing_code: 'ไม่พบรหัสยืนยันการเข้าสู่ระบบจาก MJU SSO กรุณาลองใหม่อีกครั้ง',
  sso_exchange_failed: 'การเข้าสู่ระบบด้วย MJU SSO ไม่สำเร็จ หรือรหัสหมดอายุ กรุณาลองใหม่อีกครั้ง',
};

const ssoQueryError = computed(() => {
  const code = typeof route.query.error === 'string' ? route.query.error : '';
  return code && Object.prototype.hasOwnProperty.call(SSO_ERROR_MESSAGES, code)
    ? SSO_ERROR_MESSAGES[code]
    : null;
});

function safeRelativeRedirect(candidate: unknown): string {
  if (typeof candidate !== 'string') return '/profile';
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return '/profile';
  }
  return trimmed;
}

function beginMjuSsoLogin() {
  window.location.assign('/api/v1/auth/sso/login');
}

async function submit() {
  loading.value = true;
  error.value = null;
  try {
    const data = await api.login(email.value.trim(), password.value);
    setSession(data.accessToken, data.refreshToken, data.employee);
    await router.replace(safeRelativeRedirect(route.query.redirect));
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Login failed';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <section class="card login-card">
      <p v-if="isReviewFixtureMode" class="review-banner" role="status">
        {{ reviewModeBannerText }}
      </p>
      <h1>Sign in</h1>
      <p class="muted">
        <template v-if="isReviewFixtureMode">Fixture review build — API calls are mocked in the browser.</template>
        <template v-else>Sign in with MJU SSO or local V2 credentials (<code>/api/v1/auth/*</code>).</template>
      </p>
      <p v-if="ssoQueryError" class="form-error" role="alert">{{ ssoQueryError }}</p>
      <div v-if="!isReviewFixtureMode" class="form">
        <button type="button" class="btn btn--primary" :disabled="loading" @click="beginMjuSsoLogin">
          เข้าสู่ระบบด้วย MJU SSO
        </button>
      </div>
      <form class="form" @submit.prevent="submit">
        <label class="field">
          <span>Email</span>
          <input v-model="email" type="email" autocomplete="username" required />
        </label>
        <label class="field">
          <span>Password</span>
          <input v-model="password" type="password" autocomplete="current-password" required />
        </label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button type="submit" class="btn btn--ghost" :disabled="loading">
          {{ loading ? 'Signing in…' : 'Sign in with email' }}
        </button>
      </form>
      <p class="hint muted">Fixture user: user@example.test / valid-pass (admin: admin@example.test)</p>
    </section>
  </div>
</template>
