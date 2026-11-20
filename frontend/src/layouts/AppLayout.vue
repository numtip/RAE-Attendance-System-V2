<script setup lang="ts">
import logoUrl from '../assets/brand/logo.png';
import { ORGANIZATION_LINE, SYSTEM_NAME_TH } from '../config/organization';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import { clearSession, getRefreshToken, getStoredEmployee } from '../auth/session';
import AppIcon from '../components/AppIcon.vue';
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

// ---- responsive navigation: below 1024px the sidebar is a drawer (Esc closes, Tab is trapped, focus returns) ----
const drawerOpen = ref(false);
const menuButton = ref<HTMLButtonElement | null>(null);
const sidebar = ref<HTMLElement | null>(null);
const mainEl = ref<HTMLElement | null>(null);
const initial = computed(() => (employee.value?.email ?? '?').trim().charAt(0).toUpperCase());

async function openDrawer() {
  drawerOpen.value = true;
  await nextTick();
  sidebar.value?.querySelector<HTMLElement>('a, button')?.focus();
}
function closeDrawer(restoreFocus = true) {
  if (!drawerOpen.value) return;
  drawerOpen.value = false;
  if (restoreFocus) menuButton.value?.focus();
}
function onKeydown(event: KeyboardEvent) {
  if (!drawerOpen.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (event.key !== 'Tab' || !sidebar.value) return;
  const focusable = Array.from(sidebar.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
document.addEventListener('keydown', onKeydown);
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));

// After a route change the keyboard/screen-reader user lands on the new page, not on the old link.
watch(() => route.name, async () => {
  closeDrawer(false);
  await nextTick();
  mainEl.value?.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
});
</script>
<template>
  <div class="shell">
    <a class="skip-link" href="#main">ข้ามไปยังเนื้อหา</a>
    <header class="topbar">
      <button
        ref="menuButton"
        type="button"
        class="icon-btn"
        aria-controls="sidenav"
        :aria-expanded="drawerOpen"
        aria-label="เปิดเมนู"
        @click="openDrawer"
      >
        <AppIcon name="menu" />
      </button>
      <p class="topbar-title">{{ SYSTEM_NAME_TH }}</p>
    </header>
    <div v-if="drawerOpen" class="scrim" aria-hidden="true" @click="closeDrawer()"></div>
    <aside id="sidenav" ref="sidebar" class="sidebar" :class="{ 'sidebar--open': drawerOpen }" aria-label="เมนูหลัก">
      <div class="sidebar-head">
        <div class="brand">
          <img class="brand-logo" :src="logoUrl" alt="" width="48" height="48" />
          <div>
            <p class="brand-name">{{ SYSTEM_NAME_TH }}</p>
            <p class="brand-sub">{{ ORGANIZATION_LINE }}</p>
          </div>
        </div>
        <button type="button" class="icon-btn sidebar-close" aria-label="ปิดเมนู" @click="closeDrawer()">
          <AppIcon name="close" />
        </button>
      </div>
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
            <AppIcon :name="item.name" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </div>
      </nav>
      <div v-if="employee" class="sidebar-user">
        <span class="avatar" aria-hidden="true">{{ initial }}</span>
        <span class="sidebar-user-id" :title="employee.email">{{ employee.email }}</span>
        <span class="badge">{{ roleLabel(employee.role) }}</span>
        <button type="button" class="btn btn--ghost" @click="logout"><AppIcon name="logout" />ออกจากระบบ</button>
      </div>
    </aside>
    <main id="main" ref="mainEl" class="content" tabindex="-1">
      <RouterView />
    </main>
  </div>
</template>
