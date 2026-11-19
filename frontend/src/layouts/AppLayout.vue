<script setup lang="ts">
import { ORGANIZATION_LINE, SYSTEM_NAME_TH } from '../config/organization';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import { clearSession, getRefreshToken, getStoredEmployee } from '../auth/session';
import { roleLabel } from '../utils/thai';

const route = useRoute();
const router = useRouter();
const employee = computed(() => getStoredEmployee());

const myNav = [
  { name: 'profile', label: 'ข้อมูลของฉัน' },
  { name: 'attendance-daily', label: 'ลงเวลารายวัน' },
  { name: 'attendance-monthly', label: 'สรุปรายเดือน' },
  { name: 'reports', label: 'รายงานของฉัน' },
];
const leaveNav = [
  { name: 'leave-monthly', label: 'สรุปการลารายเดือน' },
  { name: 'leave-list', label: 'รายการลา' },
  { name: 'leave-balance', label: 'วันลาคงเหลือ' },
  { name: 'leave-history', label: 'ประวัติการลา' },
];
// The server decides access (executive organization grant / manager org-unit grant); the link is only
// offered to the roles that can hold such a grant, so an employee never sees a page that always refuses.
const managementNav = computed(() => (['executive', 'manager'].includes(employee.value?.role ?? '')
  ? [
    { name: 'dashboard', label: 'แดชบอร์ดผู้บริหาร' },
    { name: 'reports-organization', label: 'รายงานองค์กร / ทีม' },
  ]
  : []));
// Leave review is limited to executives (the server also requires the organization grant).
const reviewNav = computed(() => (employee.value?.role === 'executive' ? [{ name: 'leave-review', label: 'ตรวจสอบ/อนุมัติการลา' }] : []));
const groups = computed(() => [
  { title: 'งานของฉัน', items: myNav },
  { title: 'การลา', items: leaveNav },
  ...(managementNav.value.length ? [{ title: 'ผู้บริหาร / หัวหน้างาน', items: [...managementNav.value, ...reviewNav.value] }] : []),
]);

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
  <div class="app-shell-root">
    <a class="skip-link" href="#main">ข้ามไปยังเนื้อหา</a>
    <header class="app-top">
      <div class="app-top-inner">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">RAE</span>
          <div>
            <p class="brand-name">{{ SYSTEM_NAME_TH }}</p>
            <p class="brand-sub">{{ ORGANIZATION_LINE }}</p>
          </div>
        </div>
        <div v-if="employee" class="app-user">
          <span class="app-user-id" :title="employee.email">{{ employee.email }}</span>
          <span class="badge">{{ roleLabel(employee.role) }}</span>
          <button type="button" class="btn btn--ghost" @click="logout">ออกจากระบบ</button>
        </div>
      </div>
    </header>
    <div class="app-shell">
      <div class="app-body">
        <nav class="app-nav" aria-label="เมนูหลัก">
          <div v-for="group in groups" :key="group.title" class="nav-group">
            <p class="nav-heading">{{ group.title }}</p>
            <RouterLink
              v-for="item in group.items"
              :key="item.name"
              :to="{ name: item.name }"
              class="nav-link"
              :class="{ 'nav-link--active': isActive(item.name) }"
              :aria-current="isActive(item.name) ? 'page' : undefined"
            >
              {{ item.label }}
            </RouterLink>
          </div>
        </nav>
        <main id="main" class="app-main" tabindex="-1">
          <RouterView />
        </main>
      </div>
    </div>
  </div>
</template>
