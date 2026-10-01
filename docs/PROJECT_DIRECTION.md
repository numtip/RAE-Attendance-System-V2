# Project direction

RAE Attendance System V2 is a rebuild. Legacy forensic recovery is stopped.

The legacy host `10.1.245.190` stays as it is. V2 is built from:

- the production Vue bundle contract at `/var/www/attendance-dashboard/dist/`
- the December 2025 Docker image `docker-raeserver-attendance-api:latest` as a source donor, not as a runtime
- production schema metadata that could be read without writing the database

The public API namespace is `/api/v1/`. V2 does not recreate the legacy split between `/api/` and `/attendance/api/`.

Release 1 is a foundation: health, regular login, refresh, current user, SSO login/callback/me/logout, employee profile/lookup, attendance daily/monthly, and leave list/balance/history. It does not implement the full legacy surface of 57 frontend calls.

This repository does not deploy V2 and does not change nginx, PM2, or the production database.

## Legacy database runtime decision

Legacy production database files are **recovery evidence and a data source only**, not the future runtime database.

If recovery succeeds, the path is:

`legacy files → isolated recovery lab → logical export → clean V2 database`

Do not revive the broken production InnoDB instance as the V2 runtime.
