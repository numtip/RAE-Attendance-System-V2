<script setup lang="ts">
import logoUrl from '../assets/brand/logo.png';
import { BRAND_NAME, BRAND_SUBTITLE_EN, BRAND_SUBTITLE_TH, ORGANIZATION_LINE } from '../config/organization';
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
  ...(managementNav.value.length ? [{ title: 'สำหรับผู้บริหาร', items: [...managementNav.value, ...reviewNav.value] }] : []),
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

// ---- responsive navigation: below 1024px the sidebar is a modal drawer; at >=1024px it is a plain sidebar ----
// The drawer is only "active" (modal, trapping Tab, isolating the page behind it) while it is open AND the
// viewport is below the desktop breakpoint, so a resize to desktop can never leave a stale trap behind.
const desktopQuery = window.matchMedia('(min-width: 1024px)');
const isDesktop = ref(desktopQuery.matches);
const drawerOpen = ref(false);
const drawerActive = computed(() => drawerOpen.value && !isDesktop.value);
const menuButton = ref<HTMLButtonElement | null>(null);
const sidebar = ref<HTMLElement | null>(null);
const mainEl = ref<HTMLElement | null>(null);
const initial = computed(() => (employee.value?.email ?? '?').trim().charAt(0).toUpperCase());

async function openDrawer() {
  drawerOpen.value = true;
  await nextTick();
  sidebar.value?.querySelector<HTMLElement>('.sidebar-close, a[href], button')?.focus();
}
async function closeDrawer(restoreFocus = true) {
  if (!drawerOpen.value) return;
  drawerOpen.value = false;
  if (!restoreFocus) return;
  // wait for the page behind the drawer to lose `inert`, otherwise focus() on the menu button is ignored
  await nextTick();
  menuButton.value?.focus();
}
function onBreakpoint(event: MediaQueryListEvent) {
  isDesktop.value = event.matches;
  // Leaving the drawer layout: drop the open state without moving focus (the sidebar stays on screen).
  if (event.matches) drawerOpen.value = false;
}
function onKeydown(event: KeyboardEvent) {
  if (!drawerActive.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    void closeDrawer();
    return;
  }
  if (event.key !== 'Tab' || !sidebar.value) return;
  const focusable = Array.from(sidebar.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'))
    .filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const current = document.activeElement as HTMLElement | null;
  if (!current || !sidebar.value.contains(current)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && current === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && current === last) {
    event.preventDefault();
    first.focus();
  }
}
// Keep the page behind an open drawer from scrolling.
watch(drawerActive, (active) => {
  document.body.style.overflow = active ? 'hidden' : '';
});
desktopQuery.addEventListener('change', onBreakpoint);
document.addEventListener('keydown', onKeydown);
onBeforeUnmount(() => {
  desktopQuery.removeEventListener('change', onBreakpoint);
  document.removeEventListener('keydown', onKeydown);
  document.body.style.overflow = '';
});

// After a route change the keyboard/screen-reader user lands on the new page, not on the old link.
watch(() => route.name, async () => {
  await closeDrawer(false);
  await nextTick();
  mainEl.value?.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
});
</script>
<template>
  <div class="shell">
    <a class="skip-link" href="#main" :inert="drawerActive || undefined">ข้ามไปยังเนื้อหา</a>
    <header class="topbar" :inert="drawerActive || undefined">
      <button
        ref="menuButton"
        type="button"
        class="icon-btn"
        aria-controls="sidenav"
        :aria-expanded="drawerActive"
        aria-label="เปิดเมนู"
        @click="openDrawer"
      >
        <AppIcon name="menu" />
      </button>
      <p class="topbar-title">{{ BRAND_NAME }}</p>
    </header>
    <div v-if="drawerActive" class="scrim" aria-hidden="true" @click="closeDrawer()"></div>
    <aside id="sidenav" ref="sidebar" class="sidebar"
      :class="{ 'sidebar--open': drawerOpen }"
      :role="drawerActive ? 'dialog' : undefined"
      :aria-modal="drawerActive ? 'true' : undefined"
      aria-label="เมนูหลัก"
    >
      <div class="sidebar-head">
        <div class="brand">
          <img class="brand-logo" :src="logoUrl" alt="" width="48" height="48" />
          <div>
            <p class="brand-name">{{ BRAND_NAME }}</p>
            <p class="brand-sub brand-sub--en">{{ BRAND_SUBTITLE_EN }}</p>
            <p class="brand-sub">{{ BRAND_SUBTITLE_TH }}</p>
            <p class="brand-sub brand-sub--org">{{ ORGANIZATION_LINE }}</p>
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
    <main id="main" ref="mainEl" class="content" tabindex="-1" :inert="drawerActive || undefined">
      <RouterView />
    </main>
  </div>
</template>
