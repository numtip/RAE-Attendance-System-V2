# Employee Master — F4 identity policy, N1/N2 findings and the import gate

**Date:** 2026-10-21 (phase 2) · **Branch:** `feat/employee-master-f4-identity` (based on `main` @ `888e50d`)
**Production:** **FROZEN.** No VPS session, deploy, migration, database write, real-data import or SSO activation.
**Gate result:** **`EMPLOYEE_MASTER_REVIEW_COMPLETE`** — the F4 policy, the reconciliation and the blocker
dossier are complete and reviewable. **The import gate itself is NOT cleared** (§7–§8).
**Related:** [`adr/ADR-012-employee-uid-allocation-policy.md`](adr/ADR-012-employee-uid-allocation-policy.md),
[`memory/DECISIONS.md`](memory/DECISIONS.md), [`memory/NEXT_STEPS.md`](memory/NEXT_STEPS.md)

> **Why this document is safe to commit.** It contains counts, gate names and the five disputed **HIP codes**
> that are already named in committed project memory (`1013`, `1015`, `1032`, `2019`, `3009`). It contains **no
> name, no email and no national ID**. The tools that produce it refuse to emit those values
> (`assertNoPersonalData`), and per-code detail lives only in gitignored `database/local/**`.

---

## 1. Scope

1. **N1** — reconcile the 5 master codes absent from the owner-approved 49-person roster.
2. **N2 / F2** — investigate the one changed name and test the `name` / `c_name` semantics.
3. **F5, F6, F9, F10, R-F4a** — review, and implement only what an existing decision authorises.
4. **F4 PR** — verify the isolated branch against current `main`, run regression + secret/PII scans, open a
   Draft PR. No merge.

## 2. Verification of the starting point

| Check | Result |
|---|---|
| `feat/employee-master-f4-identity` @ `33ee570` | present, 1 commit ahead of `main`, 0 behind |
| `origin/main` local ref | `888e50d` — **matches live `git ls-remote origin main`** (no drift) |
| Branch ancestry | `888e50d` + 1 commit; nothing else on the branch |
| Working tree | unchanged from session start: 10 pre-existing modified files, untracked WIP preserved |
| Stashes / worktrees | `stash@{0}`, `stash@{1}` intact; no new worktree created |

**Jev (Agent Core):** consulted once — disposition `FALLBACK`, decision `defer_to_human`, confidence `0.06`,
`requires_human_approval: true`. Advisory only; it approved nothing and blocked nothing.

## 3. Ledger state on the base branch — a correction

`main`'s applied migration ledger is **`001`–`014` plus `025`–`026`**. Migrations **`015`–`024`** — the
identifier namespace triggers, `attendance_events`, and `employee_assignment` — exist **only on the unmerged
slice stack**. Consequences, all verified against `origin/main` rather than assumed:

| Claim | On `main`? | How it is stated now |
|---|---|---|
| `employees.employee_uid` is `VARCHAR(36) NOT NULL`, no default/CHECK/trigger | **yes** (`002`) | unchanged |
| `uk_employee_identifier_type_value` + FK to `employees` | **yes** (`013`) | unchanged |
| `daily_attendance` / `monthly_summary` declare no FK to `employees` | **yes** (`004`, `005`) | unchanged |
| `attendance_events` has a `RESTRICT` FK | **no** (`016`) | now marked **(slice stack)** |
| namespace-claim triggers | **no** (`017`) | now marked **(slice stack)** |
| `employee_assignment` / effective-dating | **no** (`020`) | now marked **(slice stack)**; F5's `effective_from` is a slice-stack schema fact |

This was corrected in ADR-012 §1 and §4, because a rule that leans on a trigger absent from the base branch is
a rule that silently does not run. A related observation, not fixed here: the slice stack proposes
`025_identity_evidence`, the same number `main` already uses for `025_revoked_access_tokens`. The filename-keyed
ledger means they do not literally collide, but the numbering is ambiguous and should be renumbered before that
PR lands.

## 4. N1 — the 5 codes absent from the roster

### 4.1 Evidence per code

All figures are from the 2026-10-20 workbook, the FY2569 normalized dataset (19,345 rows / 54 codes, the union
of all monthly exports per D-2026-10-20-06), the 2027 ID-card reference and the identity-reconciliation register.

| Code | Workbook status | Months / rows | Name | Dept | Emp code | Att. code | 2027 ID card | Recon method |
|---|---|---|---|---|---|---|---|---|
| `1013` | `resigned` | 12 / 365 | **no** | no | yes | yes | no | none |
| `1015` | **no workbook row reachable by code** | **1 / 28 (Feb only)** | **no** | no | **no** | **no** | no | none |
| `1032` | `active` | 11 / 337 | yes | yes | yes | yes | no | `UNTRACEABLE_NAME_ONLY` |
| `2019` | `active` | 12 / 365 | yes | yes | yes | yes | **yes** | `DEVICE_CODE_EXACT` / high |
| `3009` | `active` | 12 / 365 | yes | yes | yes | yes | **yes** | `DEVICE_CODE_EXACT` / high |

### 4.2 What that means

* **`1013` and `1015` are the two resigned people**, and their absence from a current-personnel roster is
  consistent with that. `1015` matches owner decision **D-2026-10-20-01** exactly: February-only attendance
  (28 rows, 1 month), resigned 03/2026, history preserved. Neither has a 2027 ID card — also consistent.
* **`1032`, `2019` and `3009` are `active`**, each with 11–12 months of FY2569 evidence. **Two of them hold a
  2027 ID card**, which is an issued-identity artefact for the year the roster is for. `1032` is the
  owner-confirmed new hire from D-2026-10-20-01 (337 rows, 11 months).
* Therefore **the roster is a subset of the population, not a replacement for it.** Importing it as if it were
  the full population would leave 3 active people — 2 with issued ID cards — and their 1,000+ attendance rows
  unattached, and would imply departures that no evidence supports.
* Leading hypothesis for *why* the roster is a subset (recorded as a hypothesis, **not** a finding): all 49
  roster rows carry one institutional email domain, so the roster looks like an **MJU-account population**. That
  would systematically omit HIP-only staff — exactly the cohort the product scope says must never get a fake SSO
  account. Nothing on this machine can confirm it, because the roster is the only email source there is.

### 4.3 `1015` — a real structural defect in the master

`1015`'s workbook row carries **no `employee_code`, no `device_code`, no name, no department and no
national-ID reference**. It is reachable only by its `person_key` column, which is not the HIP code. It is the
only row in the 54 with no usable code at all.

This exposed a **defect in the reconciliation tool** shipped in the previous phase: given a master source
without a `report_code` column, the tool silently skipped that row and reported **53 codes / 4 missing** instead
of 54 / 5 — a denominator that quietly shrinks, which is the precise failure this project has already been
bitten by. Fixed in this change: the row is now reported as `MASTER_ROW_WITHOUT_CODE`, the counts add up
(`master_codes + master_rows_unkeyable = master_rows`), and the CLI exits non-zero. Evidence for the linkage
between that row and code `1015` is corroborative only — index alignment (same position in both 54-row files),
`source_workbook_row` 11, `resigned` status, and the fact that `1015` is the only reconciliation code with no
master key. **It is not proof, and it is not acted on** (owner question **O-3**).

### 4.4 What was *not* done

No record was removed, merged, re-pointed or marked resigned. No UID was allocated. No employment date was
inferred. The reconciliation states in its own output that absence from a personnel export is not a resignation.

## 5. N2 / F2 — name semantics and the one changed name

### 5.1 The semantics are strongly supported but undocumented by the source

| Test | Result |
|---|---|
| Roster `name` equals the **first** token of the workbook full name | **49 / 49** |
| Roster `c_name` equals the **second** token | **48 / 49** |
| `name + ' ' + c_name` equals the workbook full name exactly | **48 / 49** |
| Roster `name` values that also occur as anyone's **family** name | **0** |
| Roster `c_name` values that also occur as anyone's **given** name | **0** |
| Workbook rows with exactly two name tokens | 52 of 54 (the other 2 are `1013`/`1015`, no name at all) |
| Duplicated values across the roster | only in `c_name`: 2 values shared by exactly 2 rows each — the signature of siblings sharing a family name; `name` is 49/49 unique |

So `name` = given name and `c_name` = family name is supported 48/49 with **zero counter-examples** in either
direction. It is still a **statistical** conclusion: the roster does not document its columns, and `c_name`
could plausibly have meant something else. F2 therefore stays `CONDITIONAL` and the assumption is **not**
encoded — the tooling keeps `nameTh` and `cNameTh` separate and never concatenates them into a name it writes.

### 5.2 The one changed name

| Attribute | Value |
|---|---|
| Code | `2017` |
| Field that differs | family name only (given name matches 49/49) |
| Length | 9 characters in both sources |
| Shared prefix / suffix | 7 / 1 |
| Same first character | yes |
| Same character multiset | **no** |
| Effect | a **single-character substitution** mid-string — not a truncation, not a reordering, not a transliteration, not an extra space |
| Both sources current-looking | workbook status `active`; the roster carries a 2027 ID card for this person |
| Action taken | **none** — no overwrite, no name-based merge, no new identity |

Both spellings are plausible; choosing one is an owner decision (**O-5**), not an inference this change may make.
Identity remains anchored on the HIP code, which matches exactly.

## 6. Gate status

Statuses are **computed** by the tool (`assessImportReadiness` per row, aggregated), not asserted in prose.

### 6.1 Per-row import readiness

```
assessed=54  ready=0  blocked=54
blocked by gate : {"F5": 54, "F1": 5, "F2": 5, "F3": 5, "F10": 1}
blocked by code : {"EFFECTIVE_FROM_UNVERIFIED": 54, "EMAIL_MISSING_OR_INVALID": 5,
                   "NAME_MISSING_OR_UNCONFIRMED": 5, "EMPLOYEE_TYPE_MISSING_OR_INVALID": 5,
                   "EMPLOYEE_CODE_MISSING": 1}
```

### 6.2 Gate by gate

| Gate | Status | Detail |
|---|---|---|
| **F1** `email` | `RESOLVED` for 49 / open for 5 | 49/49 unique, one domain. The 5 non-roster people have no email source anywhere. |
| **F2** names | `CONDITIONAL` | semantics supported 48/49 with 0 counter-examples but undocumented; 1 spelling dispute (§5) |
| **F3** `employee_type` | `RESOLVED` | 49/49 in the enum, corroborated 1:1 by the Thai description column |
| **F4** `employee_uid` | `RESOLVED` (policy) + implemented + tested | ADR-012; 36 tests; DB-level enforcement still **R-F4a** |
| **F5** effective dates | **`BLOCKED`** — 54/54 rows | no verified `effective_from` exists for anyone. Now enforced in code: a date without an evidence reference is refused (`EFFECTIVE_FROM_UNVERIFIED`), and placeholder dates are refused separately (`EFFECTIVE_FROM_IS_PLACEHOLDER`). |
| **F6** names for `1013`/`1015` | **`BLOCKED`** — 2 rows | no name exists in any source on this machine |
| **F9** national-ID path | **`BLOCKED`** (global approval) + **partially hardened** | HMAC-lookup-only is now enforced as a guard (`assertNationalIdLookupOnly`): a raw value passed to a storage path throws `NATIONAL_ID_RAW_REJECTED`, and a digest without its key version throws `NATIONAL_ID_KEY_VERSION_MISSING`. The 49 roster national IDs still may not be imported until approved. |
| **F10** missing employee code | **`BLOCKED`** — 1 row (`1015`) | `1015` has neither an employee code nor a device code in the workbook; the attendance export does carry code `1015`. Not derived, not synthesised. |
| **R-F4a** DB-level UUID check | **`PROPOSED`** — not applied, not engine-verified | `database/proposals/027_employee_uid_uuid_v4.{up,down}.sql` + read-only `database/preflight/027_preflight.sql` (§7) |

### 6.3 What was implemented, and why each change was authorised

| Change | Authority |
|---|---|
| `employeeUidAllocation` (F4) | owner-approved F4 policy, ADR-012 |
| `employeeMasterImportGuards` (F5/F6/F10 per row, F9 global) | D-2026-10-20-03 ("nothing is invented to satisfy a `NOT NULL`"), F6/F9/F10 gate entries |
| unkeyable-master-row reporting | D-2026-10-20-08's principle: never quote a number that silently changed its denominator |
| `027` migration proposal + preflight | R-F4a in ADR-012 §4/§7 |
| nothing else | F1/F2/F3/F5/F6/F9/F10 values, dates, names and codes were **not** invented |

### 6.4 Independent security review — four defects found and fixed

The branch was reviewed independently. The reviewer worked against the **dirty working tree** rather than the
branch, so several of its findings describe files that are not in this PR (the 337-file diff it reports is the
incident checkout, not this 17-file branch). Those are recorded in §6.5. Four findings **were** genuine defects
in this branch's own files, and all four are fixed with regression tests:

| # | Defect | Why it mattered | Fix |
|---|---|---|---|
| 1 | **National-ID ownership could never match.** Existing rows store an HMAC digest (migration `015`), but the plan keyed candidates on raw 13 digits. | A returning person whose only match was their national ID would be classified `CREATE` and receive a **second UID** — the exact failure "one person one UID" exists to prevent. | Ownership keys are `national_id_lookup` (digest) only. A candidate's raw ID is converted with the injected `nationalIdLookup`; if that is unavailable the row is **`QUARANTINE`**, never `CREATE`. An existing row carrying a raw ID now fails closed (`EXISTING_NATIONAL_ID_UNVERIFIABLE`) instead of being silently ignored. |
| 2 | **The explicit-UID path could share a UID.** Two candidates could claim the same explicit UID, and an explicit UID belonging to someone else could attach a stranger's identifier. | UID sharing = identity merge = attendance misattribution. | Batch-wide `claimedUids` (seeded from existing), duplicate explicit UIDs → `DUPLICATE_EMPLOYEE_UID`, an explicit UID that exists but has **no** matching identifier → `EXPLICIT_UID_WITHOUT_IDENTIFIER_MATCH`, and a generated UID colliding with anything already claimed → `EMPLOYEE_UID_COLLISION`. |
| 3 | **`--json` could leak PII through dictionary keys.** `by_employment_status` used the raw CSV value as a key, and the guard only inspected string values. | A malformed source could put a national ID or email into a summary key and out to stdout; the detail file had the same free-text exposure. | Employment status and employee type are allowlisted (unknown → `UNKNOWN`), row references must be digits, the guard now inspects keys **and** numbers, and the **whole detail artefact** is asserted — not just the summary. |
| 4 | **The detail path was cwd-relative**, so running the CLI from `backend/` wrote outside the gitignored tree; and the preflight printed an 8-character prefix of a nonconforming UID. | Per-code data outside `database/local/` can be committed; a UID that is nonconforming may be a pasted national ID, so even a prefix discloses it. | New `resolveLocalOutputPath(repoRoot, …)` resolves against the repository root and proves containment. The preflight now emits length, a reason bucket and `SHA2(uid,256)` only. |

| Also tightened |
|---|
| The previously vacuous "two runs differ" test now exercises the **default** generator and asserts both values are valid and distinct. |
| The SQL-parity test now also rejects `PREPARE`/`EXECUTE` in the preflight, and asserts no part of a UID is selected. |
| `employeeUidAllocation` documentation states the national-ID digest rule explicitly (`POLICY.national_id_key = 'lookup_digest_only'`). |
| `F5`'s evidence reference is documented as a **contract, not proof** — it cannot be authenticated by a pure module, the same honest limitation ADR-011 records for SSO evidence. No row is called "date verified" on the strength of a non-empty string. |

### 6.5 Findings outside this PR (reported, not acted on)

These were raised by the same review but the code is **not** part of this branch; fixing them here would widen a
policy PR into unrelated auth work.

| Item | Where it lives | Note |
|---|---|---|
| Agent Core sends `question`, `intent` and `use_case` unsanitised — only `context` is checked | `agent/decisions.js` (on `main`, unchanged here) | This touches the repo's hard "no PII to Agent Core" rule and deserves its own change and test. **Not verified by me**; the reviewer flagged it. |
| SSO handoff code not bound to the browser (login CSRF); state store unbounded; non-numeric `SSO_LOGIN_HANDOFF_TTL_MS` → never expires | `backend/src/services/sso/*` (on `main`/slice stack) | SSO is not activated and these paths are fail-closed today; out of scope for an F4 PR. |
| `scripts/data-recovery/__pycache__/*.pyc` untracked in the working tree | local only | Not in this branch. `.gitignore` now ignores `__pycache__/` and `*.pyc` so they cannot be added by accident. |
| **Two checksum-valid 13-digit literals in `backend/tests/employeeIdentity.test.js`** | on `main`, untouched by this branch | My branch-level PII scan found 2 values that pass the Thai national-ID checksum, both masked `****0000`, used as `resolve('national_id', …)` arguments. That shape is consistent with deliberately synthetic fixtures, but it is **unverified**, and `nationalIdFixtureHygiene.test.js` — the guard built for exactly this — exists only on the slice stack and does not run on `main`. **Not a finding against this branch** (the branch introduces no checksum-valid literal; its `9900000000002` fixture is checksum-invalid by construction). Worth handing to whoever lands the hygiene guard. |

## 7. R-F4a — the proposed schema constraint

`database/proposals/027_employee_uid_uuid_v4.up.sql`:

```sql
ALTER TABLE employees
  ADD CONSTRAINT chk_employees_employee_uid_uuid_v4
  CHECK (
    CHAR_LENGTH(employee_uid) = 36
    AND employee_uid REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  );
```

Design points, and the MariaDB reasoning behind each:

* **`CHECK`, not a trigger.** Enforced from MariaDB 10.2.3 — already this repo's floor (`015`/`020`) — and
  visible in `information_schema`, so it cannot be bypassed by a connection holding `INSERT` but not `TRIGGER`.
* **Both cases spelled out (`[0-9a-fA-F]`, `[89abAB]`).** `employees` is `utf8mb4_unicode_ci`, so `REGEXP` may
  compare case-insensitively; writing both cases makes the outcome independent of the connection collation.
* **`CHAR_LENGTH = 36` included.** `VARCHAR(36)` can hold trailing spaces, which `=` comparisons ignore but
  `REGEXP` does not.
* **Idempotent** via an `information_schema.TABLE_CONSTRAINTS` guard, matching the style of `020`.
* **Fails closed, never repairs.** Adding a `CHECK` validates existing rows, so one bad UID aborts the
  migration. There is deliberately no data-fix step: rewriting a primary key could orphan attendance rows,
  because `daily_attendance` and `monthly_summary` have no FK to `employees`.
* **Preflight is read-only** and does three things: probe the engine's regex behaviour (5 probes, including
  version-nibble, variant-nibble, non-UUID and trailing-space rejections), count non-conforming rows (must be
  **0**), and check for `daily_attendance` orphans as context. It does **not** use `UUID()` as the positive
  probe, because MySQL/MariaDB `UUID()` returns a **version-1** value.
* **Numbered 027** because `main`'s ledger already ends at `026`; it lives in `database/proposals/`, which the
  migration runner does not read — verified in `scripts/migrate.mjs`, and asserted by a test.

**Honest limitation:** this SQL has **not** been executed on any MariaDB by this change — there is no server on
this workstation. A JS test proves the SQL regex and the JavaScript rule accept exactly the same sample set
(parity), but parity is not engine behaviour. Approval requires running the preflight and then the ALTER against
a disposable MariaDB, exactly as F7 already requires for the import rehearsal.

## 8. Owner decisions needed

| ID | Question | Why it blocks |
|---|---|---|
| **O-1** | Is the 49-person roster the **complete** current population, or is it a subset (e.g. MJU-account holders only)? | Evidence says subset: 3 `active` people are absent, 2 with 2027 ID cards. Determines whether the import is roster-shaped or population-shaped. |
| **O-2** | If it is a subset: approve an **additive** import that preserves all 54 identities and takes the roster as authoritative only for the 49 fields it supplies. | The safe default, but it is an owner call, not an agent one. |
| **O-3** | Is the workbook row with **no HIP code** (`source_workbook_row` 11, `resigned`) the same person as code **`1015`**? | Would let F10 be fixed by carrying the attendance code; until confirmed, `1015` has no identifier but its attendance rows. |
| **O-4** | Confirm `name` = given name and `c_name` = family name. | Closes F2. Evidence is 48/49 with 0 counter-examples but the source documents nothing. |
| **O-5** | Which spelling is current for code **`2017`**? | One-character family-name difference; no automatic overwrite is permitted. |
| **O-6** | Supply a verified `effective_from` per person, or approve a documented placeholder policy. | Blocks F5 for all 54 rows. |
| **O-7** | Supply owner-confirmed names for **`1013`** and **`1015`**. | Blocks F6 for 2 rows. |
| **O-8** | Approve or reject the national-ID HMAC-lookup-only import path. | Blocks F9; 49 national IDs are waiting. |
| **O-9** | Approve `027` and run its preflight against a disposable MariaDB. | Closes R-F4a; currently policy-only enforcement. |

Carried forward and untouched: the 19-code `dataperson.csv` exclusion (D-2026-10-20-09) and the 24/25/26
discrepancy counts (D-2026-10-20-08). Neither is resolvable from this roster.

## 9. Reconciliation result (49 against 54)

| Metric | Value |
|---|---|
| Roster rows / unique codes / unique national IDs | 49 / 49 / 49 |
| Master rows / usable codes / unkeyable rows | 54 / 54 / 0 (integration source) · 54 / 53 / **1** (workbook-only source) |
| Matched | **49** |
| Changed | **1** (name) |
| Missing from roster | **5** (all with FY2569 attendance; 3 `active`; 2 without a confirmed name) |
| Extra in roster (unknown code) | **0** |
| Conflicting identities | **0** — no national ID under two codes, no duplicate roster code, no duplicate full name, no employee_type outside the enum |
| Roster codes also in the 2027 ID-card reference | 48 of 49 |

## 10. QA

| Suite | Result |
|---|---|
| Backend suite (`npm test`, `TZ=UTC`, fixture `JWT_SECRET`) | **583 pass, 12 skipped, 0 fail** (595 tests; was 550/12/0 at the start of this phase) |
| F4 identity policy (`employeeUidAllocation`) | **36 / 36** — incl. 54-identity preservation, 49-row re-import = 0 `CREATE`, idempotent replay, HMAC-only national-ID matching, duplicate explicit UIDs, explicit-UID-without-identifier, UID collision |
| Import guards (`employeeMasterImportGuards`) | **14 / 14** |
| SQL ↔ JS parity (`employeeUidConstraintSql`) | **7 / 7** — incl. "the proposal is not in `database/migrations/`" and "the preflight selects no part of a UID" |
| Roster reconciliation (`rosterReconciliation`) | **24 / 24** — incl. unkeyable row reported, UNKNOWN ≠ 0, cwd-independent detail path, PII in keys/numbers refused |
| Data-onboarding suites together | **53 / 53** |
| Lint (`eslint src tests`) | clean |
| Fixture PII hygiene (`nationalIdFixtureHygiene`) | **pass** — no checksum-valid literal added, no exemption requested |
| Real-data run (both master sources) | exit 0 for the full source; non-zero for the unkeyable source (by design); both write inside `database/local/` even when invoked from `backend/` |
| Secret scan | see §11 |
| **Isolated branch verification** (own tree extracted, `main` base) | see §11 |

Not run, and not claimed: any MariaDB suite, any migration application, any deploy, any VPS or network data access.

## 11. Changed files and PR

**Added**

| File | Purpose |
|---|---|
| `backend/src/domain/employeeUidAllocation.js` | F4 policy (ADR-012 §2), including the national-ID lookup-digest rule |
| `backend/src/domain/employeeMasterImportGuards.js` | F5/F6/F10 per-row guards, F9 national-ID guard, readiness summary |
| `backend/tests/employeeUidAllocation.test.js` | 36 tests |
| `backend/tests/employeeMasterImportGuards.test.js` | 14 tests |
| `backend/tests/employeeUidConstraintSql.test.js` | 7 parity/guardrail tests for the SQL proposal |
| `scripts/data-onboarding/csvText.mjs` | dependency-free RFC-4180 reader |
| `scripts/data-onboarding/rosterReconciliation.mjs` | pure reconcile + redaction + path guards |
| `scripts/data-onboarding/reconcile-roster-2027.mjs` | CLI: sanitized counts to stdout, detail to `database/local/` |
| `scripts/data-onboarding/rosterReconciliation.test.mjs` | 24 tests |
| `database/proposals/027_employee_uid_uuid_v4.up.sql` | proposed `CHECK` (§7) |
| `database/proposals/027_employee_uid_uuid_v4.down.sql` | guarded rollback |
| `database/preflight/027_preflight.sql` | read-only pre-application evidence |
| `docs/adr/ADR-012-employee-uid-allocation-policy.md` | decision record |
| `docs/EMPLOYEE_MASTER_F4_IDENTITY_POLICY.md` | this report |

**Modified:** `.github/workflows/ci.yml` (one line: the data-onboarding step also runs the reconciliation
test), `.gitignore` (four rules: `database/roster*.csv` so the owner-supplied roster cannot be committed;
`!database/proposals/*.sql`, because the blanket `*.sql` rule was silently ignoring *every* migration proposal
— the one place unapplied SQL is supposed to be reviewed from, as the existing `!database/preflight/*.sql` and
`!database/rollbacks/*.sql` exceptions already show; and `__pycache__/` + `*.pyc` so local bytecode can never be
added), `docs/memory/DECISIONS.md` (appended `D-2026-10-21-01`, append-only verified: 28 additions, 0 deletions).

**Not changed:** no migration applied, no schema altered, no seed, no backend service wiring, no frontend, no
`package.json`, no existing WIP, no stash, no worktree.

## 12. Reproduction

```powershell
# Policy + guard + SQL parity tests
cd backend
node --test tests/employeeUidAllocation.test.js tests/employeeMasterImportGuards.test.js tests/employeeUidConstraintSql.test.js
cd ..

# Reconciliation + computed gate status (read-only; both inputs are local and gitignored)
node scripts/data-onboarding/reconcile-roster-2027.mjs `
  --roster database/roster_rae2027.csv `
  --master database/local/fy2569-integration-20261020/employee_master_integration.csv `
  --out    database/local/f4-20261021/roster-reconciliation.json

# The unkeyable-row case (exits 1 by design)
node scripts/data-onboarding/reconcile-roster-2027.mjs `
  --roster database/roster_rae2027.csv `
  --master database/local/recovery-20261020/normalized_employee_master.csv
```

## 13. Next gate

1. **Owner answers O-1 … O-5** (population scope, the `1015` linkage, name semantics, the `2017` spelling).
   These unblock the *shape* of the import.
2. **Owner supplies O-6 … O-8** (verified dates, two names, the national-ID path). These unblock the *rows*.
3. **`MARIA_DB_REHEARSAL`** — re-run the import rehearsal against a disposable MariaDB (F7), and run
   `027_preflight.sql` there in the same session to close R-F4a's evidence gap.
4. Only then a separate, explicitly approved import.
