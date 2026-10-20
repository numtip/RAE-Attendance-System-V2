# Context index

**Latest session:** [`docs/memory/SESSION_2026-10-20.md`](SESSION_2026-10-20.md) — read this first for the employee-master / FY2569 attendance line of work.
It supersedes the 2026-10-19 restart point in the list below **for that line only**; the PR #50
release work described below is unchanged.

Current gate: `EMPLOYEE_MASTER_SCHEMA_RESOLUTION`, then `MARIA_DB_REHEARSAL`. Production is FROZEN.
Attendance evidence is complete (12/12 exports hash-attested, 19,345 rows). Import is blocked only by the employee schema.

Read in this order at the next start. Stop when the question is answered.

1. `docs/memory/SESSION_20261019.md` — this closeout. Committed on `feat/unified-attendance-fasttrack`.
2. `docs/STATUS.md` — one-page status.
3. `docs/memory/NEXT_ACTIONS.md` — tomorrow's first task.
4. `docs/memory/OWNER_QUESTIONS.md` — questions that need the owner. Do not answer them by invention.
5. `docs/phase0/FY2569_LOCAL_IMPORT.md` — import counts and the 24-versus-26 gap.
6. `docs/phase0/IMPLEMENTATION_DECISION_20261019.md` — unsigned working choices for D-01–D-10.
7. `docs/phase0/OWNER_DECISION_PACK_20261019.md` — only in the worktree, untracked. Signature sheets are blank.
8. Blueprint V1 and the 2026-10-15 VPS summary / VPS-B audit — historical host evidence. Live host state is UNKNOWN.

`origin/main` at the 2026-10-20 closeout was `6bec273`. PR #50 head before the closeout commit is `d46199c`. The incident checkout at `039c4e0` is preserved WIP and is not the restart branch.

Source repo for FY2569, local only: `G:\ProjectAI\attendance-report-generator`. Disposable database: `attendance_fy2569_local` on WSL2 Ubuntu MariaDB. Credentials stay in gitignored `.local`.
