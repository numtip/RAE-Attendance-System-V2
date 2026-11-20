<script setup lang="ts">
import { errorMessageTh } from '../utils/i18n';
import logoUrl from '../assets/brand/logo.png';
import { BRAND_NAME, BRAND_SUBTITLE_EN, BRAND_SUBTITLE_TH, ORGANIZATION_LINE } from '../config/organization';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import { setSession } from '../auth/session';
import AppIcon from '../components/AppIcon.vue';
import { isReviewFixtureMode, reviewModeBannerText } from '../config/reviewMode';

const route = useRoute();
const router = useRouter();

// Local email/password sign-in exists for the fixture review build and, behind VITE_LOCAL_LOGIN, for
// operator-created local accounts. Production employees are SSO-only (no local password is ever
// issued), so offering that form there only produces a login that cannot succeed, and the fixture
// credentials must never be pre-filled for a real user.
const showLocalLogin = isReviewFixtureMode || import.meta.env.VITE_LOCAL_LOGIN === 'true';
const email = ref(isReviewFixtureMode ? 'user@example.test' : '');
const password = ref(isReviewFixtureMode ? 'valid-pass' : '');
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
    error.value = errorMessageTh(e, 'เข้าสู่ระบบไม่สำเร็จ');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login">
    <section class="login-hero" aria-label="เกี่ยวกับระบบ">
      <img class="login-logo" :src="logoUrl" alt="ตรามหาวิทยาลัยแม่โจ้" width="104" height="104" />
      <div>
        <h2>{{ BRAND_NAME }}</h2>
        <p class="login-sub">{{ BRAND_SUBTITLE_EN }}</p>
        <p class="login-sub login-sub--th">{{ BRAND_SUBTITLE_TH }}</p>
        <p class="login-org">{{ ORGANIZATION_LINE }}</p>
      </div>
      <ul class="login-points">
        <li><AppIcon name="clock" />ดูเวลาปฏิบัติงานรายวันและสรุปรายเดือน</li>
        <li><AppIcon name="leave-monthly" />ติดตามรายการลาและวันลาคงเหลือ</li>
        <li><AppIcon name="reports" />รายงานส่วนบุคคล ทีม และองค์กร</li>
      </ul>
    </section>
    <main class="login-panel">
      <section class="card login-card" aria-labelledby="login-title">
        <p v-if="isReviewFixtureMode" class="review-banner" role="status">
          {{ reviewModeBannerText }}
        </p>
        <h1 id="login-title">เข้าสู่ระบบ</h1>
        <p class="muted">เข้าสู่ระบบเพื่อใช้งาน STAR</p>
        <p v-if="ssoQueryError" class="form-error" role="alert">{{ ssoQueryError }}</p>
        <div v-if="!isReviewFixtureMode" class="form">
          <button type="button" class="btn btn--primary btn--wide" :disabled="loading" @click="beginMjuSsoLogin">
            <AppIcon name="shield" />เข้าสู่ระบบด้วย MJU SSO
          </button>
        </div>
        <form v-if="showLocalLogin" class="form" @submit.prevent="submit">
          <label class="field">
            <span>อีเมล</span>
            <input v-model="email" type="email" autocomplete="username" required />
          </label>
          <label class="field">
            <span>รหัสผ่าน</span>
            <input v-model="password" type="password" autocomplete="current-password" required />
          </label>
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
          <button type="submit" class="btn btn--primary" :disabled="loading">
            {{ loading ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบด้วยอีเมล' }}
          </button>
        </form>
        <p v-if="isReviewFixtureMode" class="hint muted">ผู้ใช้ตัวอย่าง: user@example.test / valid-pass (ผู้ดูแล: admin@example.test)</p>
        <p class="login-foot">{{ ORGANIZATION_LINE }}</p>
      </section>
    </main>
  </div>
</template>
