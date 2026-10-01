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
];

function isActive(name: string): boolean {
  return route.name === name;
}

async function logout() {
  const refreshToken = getRefreshToken();
  try {
    if (refreshToken) {
      await api.logout(refreshToken);
    }
  } catch {
    /* session cleared on 401 */
  } finally {
    clearSession();
    await router.push({ name: 'login' });
  }
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
