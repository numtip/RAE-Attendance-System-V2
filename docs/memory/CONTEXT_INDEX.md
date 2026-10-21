# Context index

**Latest session:** [`SESSION_2026-10-21.md`](SESSION_2026-10-21.md) — **read this first.**
It supersedes the 2026-10-20 restart point entirely: F4 is merged, the migrations are rehearsed on a real engine,
and a new P0 is open.

**Current gate:** `DAY_20261021_CLOSED_WITH_SECURITY_FOLLOWUP`
**Production:** **FROZEN.** No deploy, host migration, real-data import or SSO activation.
**Open P0:** a checksum-valid national ID is still in **public** `origin/main` and its history — see
[`../security/NATIONAL_ID_INCIDENT_20261021.md`](../security/NATIONAL_ID_INCIDENT_20261021.md). It is **not**
resolved.

`origin/main` is `2770657` (PR #57). The checkout in `G:\ProjectAI\rae-attendance-system-v2` is the **dirty
incident branch** `docs/r5-decision-review-20261019` @ `039c4e0` — it is preserved WIP, **not** the restart branch.

---

## Read in this order

1. [`../reports/EOD_2026-10-21.md`](../reports/EOD_2026-10-21.md) — what happened, verified counts.
2. [`SESSION_2026-10-21.md`](SESSION_2026-10-21.md) — the narrative, and the mistakes worth not repeating.
3. [`../security/NATIONAL_ID_INCIDENT_20261021.md`](../security/NATIONAL_ID_INCIDENT_20261021.md) — **the P0 and
   its remediation plan. Do not start remediation without owner decision `S1`.**
4. [`NEXT_STEPS.md`](NEXT_STEPS.md) — the ordered task list.
5. [`OWNER_QUESTIONS.md`](OWNER_QUESTIONS.md) — what only the owner can decide. Do not answer by invention.
6. [`DECISIONS.md`](DECISIONS.md) — append-only. Today's entries are `D-2026-10-21-01` … `-05`.
7. [`../STATUS.md`](../STATUS.md) — one page.

---

## Open pull requests (verified 2026-10-21 16:00 UTC+7)

| PR | Branch | State | CI | Files |
|---|---|---|---|---|
| [#58](https://github.com/numtip/RAE-Attendance-System-V2/pull/58) | `fix/derived-employee-uid` | OPEN, MERGEABLE | 8/8 | 8 |
| [#59](https://github.com/numtip/RAE-Attendance-System-V2/pull/59) | `feat/sso-signout-hardening` | OPEN, MERGEABLE | 8/8 | 8 |
| [#60](https://github.com/numtip/RAE-Attendance-System-V2/pull/60) | `feat/f9-national-id-hmac` | OPEN, MERGEABLE | 8/8 | 11 |
| [#61](https://github.com/numtip/RAE-Attendance-System-V2/pull/61) | `feat/migration-stack-015-024` | OPEN, MERGEABLE | 8/8 | 21 |

**None is merged. Recommended order: #58 → #60 → #59 → #61**, or #60 first on security priority. #60 is the only
change that removes the P0 value from `main`'s source.

---

## Environment you will need

| Item | Value |
|---|---|
| Disposable MariaDB | **WSL2 distro `Ubuntu-22.04-G`** at `G:\WSL\Ubuntu-22.04-G`, MariaDB **10.6.23** on `127.0.0.1:3306` |
| CI engine | `mariadb:11.4` — **not** the same minor version as local; say so when quoting local evidence |
| Docker | not installed on this workstation |
| Owner-supplied personnel source | `database/roster_rae2027.csv` — **untracked, gitignored, never commit** |
| Source repo for FY2569 | `G:\ProjectAI\attendance-report-generator` (local only) |
| Credentials | `.env` / `.local` — never committed |
| Jev (Agent Core) | one advisory call per session, `.cursor/rules/agent-core-jev.mdc` |

---

## Standing rules that have bitten this repo before

- The value `****5351` must never be reproduced **in any encoding**. It is currently still public — see the P0.
- A checksum-valid 13-digit literal is a leak whether or not it is real. `nationalIdFixtureHygiene.test.js`
  (PR #60) enforces this.
- Never `git add -A`; build branches from explicit blobs; verify append-only files show **0** deletions.
- Never quote a single discrepancy count — 24 / 25 / 26 measure different things.
- The derived event stream is **not** evidence of employment. Use the union of monthly exports.
- Fixture-green is necessary, not sufficient. A control that is never called is not a control.
