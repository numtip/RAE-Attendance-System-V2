import { createRouter, createWebHistory } from 'vue-router';
import { isAuthenticated } from '../auth/session';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
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
