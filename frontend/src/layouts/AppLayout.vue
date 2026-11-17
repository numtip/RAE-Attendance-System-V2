<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import { clearSession, getRefreshToken, getStoredEmployee } from '../auth/session';

const route = useRoute();
const router = useRouter();
const employee = computed(() => getStoredEmployee());

const nav = [
  { name: 'profile', label: 'Profile' },
  { name: 'attendance-daily', label: 'Daily attendance' },
  { name: 'attendance-monthly', label: 'Monthly summary' },
  { name: 'leave-list', label: 'Leave list' },
  { name: 'leave-balance', label: 'Leave balance' },
  { name: 'leave-history', label: 'Leave history' },
  { name: 'reports', label: 'My report' },
];

function isActive(name: string): boolean {
  return route.name === name;
}

async function logout() {
  const refreshToken = getRefreshToken();
  let signoutUrl: string | undefined;
  try {
    if (refreshToken) {
      // The server revokes the access + refresh tokens before returning, so the session is dead server-side
      // before the browser navigates away. When SSO is disabled on this deployment, fall back to `/auth/logout`
      // so password sessions still revoke both server-side tokens cleanly.
      try {
        const result = await api.ssoLogout(refreshToken);
        signoutUrl = result.signoutUrl;
      } catch {
        await api.logout(refreshToken);
      }
    }
  } catch {
    // Already logged out or expired: a repeated logout must stay safe.
  } finally {
    // Only application-owned keys are removed. RAE V2 sets no auth cookie, so nothing else is touched.
    clearSession();
  }
  if (signoutUrl) {
    // Full navigation, not router.push: the IdP signout page is off-origin.
    window.location.assign(signoutUrl);
    return;
  }
  await router.push({ name: 'login' });
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div>
        <p class="app-kicker">RAE Attendance V2</p>
        <h1 class="app-title">Release 1</h1>
      </div>
      <div v-if="employee" class="app-user">
        <span>{{ employee.email }}</span>
        <span class="badge">{{ employee.role }}</span>
        <button type="button" class="btn btn--ghost" @click="logout">Log out</button>
      </div>
    </header>
    <div class="app-body">
      <nav class="app-nav" aria-label="Main">
        <RouterLink
          v-for="item in nav"
          :key="item.name"
          :to="{ name: item.name }"
          class="nav-link"
          :class="{ 'nav-link--active': isActive(item.name) }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
      <main class="app-main">
        <RouterView />
      </main>
    </div>
  </div>
</template>
