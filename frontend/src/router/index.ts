import { createRouter, createWebHistory } from 'vue-router';
import { isAuthenticated } from '../auth/session';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { guest: true },
    },
    {
      path: '/auth/sso/complete',
      name: 'sso-complete',
      component: () => import('../views/SsoCompleteView.vue'),
      meta: { guest: true },
    },
    {
      path: '/',
      component: () => import('../layouts/AppLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        { path: '', redirect: { name: 'profile' } },
        {
          path: 'profile',
          name: 'profile',
          component: () => import('../views/ProfileView.vue'),
        },
        {
          path: 'attendance/daily',
          name: 'attendance-daily',
          component: () => import('../views/AttendanceDailyView.vue'),
        },
        {
          path: 'attendance/monthly',
          name: 'attendance-monthly',
          component: () => import('../views/AttendanceMonthlyView.vue'),
        },
        {
          path: 'leave',
          name: 'leave-list',
          component: () => import('../views/LeaveListView.vue'),
        },
        {
          path: 'leave/balance',
          name: 'leave-balance',
          component: () => import('../views/LeaveBalanceView.vue'),
        },
        {
          path: 'leave/history',
          name: 'leave-history',
          component: () => import('../views/LeaveHistoryView.vue'),
        },
        {
          path: 'reports',
          name: 'reports',
          component: () => import('../views/ReportsView.vue'),
        },
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('../views/ExecutiveDashboardView.vue'),
        },
        {
          path: 'leave/review',
          name: 'leave-review',
          component: () => import('../views/LeaveReviewView.vue'),
        },
        {
          path: 'leave/entitlements',
          name: 'leave-entitlements',
          component: () => import('../views/LeaveEntitlementDashboardView.vue'),
        },
        {
          path: 'leave/monthly',
          name: 'leave-monthly',
          component: () => import('../views/LeaveMonthlyView.vue'),
        },
        {
          path: 'reports/organization',
          name: 'reports-organization',
          component: () => import('../views/OrganizationReportView.vue'),
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach((to) => {
  const authed = isAuthenticated();
  if (to.meta.requiresAuth && !authed) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guest && authed) {
    return { name: 'profile' };
  }
  return true;
});

export default router;
