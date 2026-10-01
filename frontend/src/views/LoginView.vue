<script setup lang="ts">
import { ref } from 'vue';
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

async function submit() {
  loading.value = true;
  error.value = null;
  try {
    const data = await api.login(email.value.trim(), password.value);
    setSession(data.accessToken, data.refreshToken, data.employee);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/profile';
    await router.replace(redirect);
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
        <template v-else>Uses <code>/api/v1/auth/login</code> only (no legacy paths).</template>
      </p>
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
        <button type="submit" class="btn btn--primary" :disabled="loading">
          {{ loading ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
      <p class="hint muted">Fixture user: user@example.test / valid-pass (admin: admin@example.test)</p>
    </section>
  </div>
</template>
