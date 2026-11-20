# Audit — 2026-11-20 morning (production UI release)

**Scope:** read-only verification of what the morning's merges and deploy actually produced on production.
No code change, no restart, no data write.

**Verified at:** 2026-11-20 ~05:00Z · `origin/main` `3d38715` · backend image `rae-attendance-v2-backend:dark-c9e856f`
**Related:** `docs/reports/DAY_SUMMARY_2026-11-19.md` · `docs/memory/NEXT_ACTIONS.md` · day closeout PR (#124, open at time of writing)

## 1. What the deploy actually did

| Item | Value | How |
|---|---|---|
| Merged in the morning | #115 `92e98ca` (MJU logo) · #116 `be9fdd0` (Emerald 1/3) · #117 `97abaa3` (Attendance+Leave 2/3) · #118 `82f730d` (Reports 3/3) · #119 `27191f3` (status) | `gh pr view` |
| Frontend | `frontend-dist` rebuilt 2026-11-20 04:09Z; entry `index-Do9nBgKY.js` (was `index-CtWjxyR_`); `Sarabun` in 3 chunks, `emerald` in 1; `favicon-*.png` + `logo-*.png` served 200 | curl + file mtime |
| Backend | **not redeployed** — image unchanged, container age 20h at audit time | `docker inspect` |
| Method | dist files replaced under the bind-mount; nginx never restarted | container start time |
| Health | page 200 · `sso/login` 302 · api 200 · legacy `/attendance/api/health` 200 | curl |
| Legacy | `attendance-api` and the previous stack still up, untouched | `docker ps` |

## 2. Data unchanged by the morning

```
employees 52 (all active) · approved identity links 49 · 3 divisions / 52 memberships
scans 20,224 → resolved 19,896 · unmapped 328 · attendance_events 19,896
daily_attendance 10,275 · monthly_summary 569 · leave records 670 (641 candidate · 29 needs_review)
migrations 29 · attendance data present through 2026-11-18
auth_logs today 5 · 7-day: login 10 · failed_login 1
```

## 3. Findings (no fix applied — each needs an owner decision)

### F-A · The app still shows the old organisation name (medium)
`frontend/index.html` `<title>`, `backend/src/config/organization.js` and `frontend/src/config/organization.ts`
all carry the pre-rename name, and the tests pin it. The database uses the new name
(`สำนักวิจัยและบริการวิชาการ`, owner decision 2026-11-17). So the browser tab, reports and exports show the old
name while the data says the new one. #108 centralised the name but with the old value.
**Fix size:** three files plus the assertions that pin the string.

### F-B · The deployed frontend cannot be rebuilt from the host checkout (high, operational)
`/home/rae_admin/prod-dark/src` is still at `c9e856f` while the served bundle is the 2026-11-20 build. Anyone who
rebuilds from that checkout publishes the previous UI and reverts the design silently. The deploy path needs the
checkout advanced to the deployed commit (or a recorded build source).

### F-C · Three employees cannot sign in (known, unchanged)
52 employees, 49 approved identity links. The remaining three need identity evidence reviewed and approved —
never inferred from an email address.

### F-D · `employees.last_login` is never written by the SSO path (low, reporting)
Every row is `NULL`; `auth_logs` holds the real history (`login` / `failed_login`). Any “last seen” surface must
read `auth_logs`, not the column.

## 4. Not verified

- No real-employee session against the new UI. The server side can only show that five logins happened today;
  it cannot show which screens were opened. The Release 2 screens still have no REAL_USER_QA.
- The morning's `frontend-dist` build source was not recorded, which is finding F-B.

## 5. Suggested order

1. F-B (prevents silently reverting the UI on the next rebuild).
2. F-A (user-visible inconsistency between the app and the database).
3. F-C once the owner has the evidence.
4. F-D whenever a “last seen” surface is next touched.
