# PR reconciliation — 17 stale pull requests, 2026-10-29

**Purpose:** decide what happens to the draft/slice pull requests that have been open since
2026-10-02…10-16, now that the SSO and migration work has landed on `main`. Read-only analysis plus
one low-risk merge; **no branch was deleted and no unique work was dropped.**

**Pinned to** `main` = `739e6f76` for the analysis; `#44` merged afterwards as `4851a8a9`, and the
branch was verified on the rebased head `f0924c2e` before merging.

---

## 1. The finding that changes every disposition

**All 17 PRs show 8/8 green CI, and that green means nothing on today's `main`.** The newest run is
2026-10-16, the oldest 2026-10-02 — before #58 (uid derivation), #59 (signout gate), #61 (migrations),
#66 (approved-link gate) and #68 landed. A green check certifies each branch against a base 5+ commits
stale.

**`mergeable/CLEAN` is measured against each PR's stack parent, not `main`.** `git merge-tree` against
`origin/main` conflicts on **18–26 files** for every stacked PR; only #44 merged clean.

**Two regressions are provable inside the branches' trees:**

| File | On `main` today | In the slice branches |
|---|---|---|
| `backend/src/middleware/authenticate.js` | `createAuthenticate(revocations)` requiring `payload.jti` | bare `function authenticate(req,_res,next)` — **no revocation check** |
| `backend/src/services/ssoService.js` | approved-link gate from #66 | **no identity-link logic at all** |

**No branch contains migrations `025`/`026`** — the same defect #61's own message described:
merging such a branch would silently drop token revocation.

**No PR is fully superseded.** The superseded material is file-level: the 21 schema files that #61
landed as `873e539`, plus two files in #42 and one CI job in #35.

---

## 2. What was merged under this analysis

**#44 — `4851a8a9`.** `backend/tests/employeeIdentity.test.js:42,125` contained a **real Thai
national ID** (`1180200015351`) in a public repository. #44 was the only PR that merged cleanly into
today's `main`; it was rebased onto `main`, re-run (backend 236 tests / 218 pass / 0 fail /
18 skipped, secret scan clean), marked ready and merged. The literal is now absent from `main`
(verified by reading the file back at `main`). Its incident record
(`docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`) is the only account of why it was there.

*Note:* #60 also replaces those two lines. Whichever lands second must keep the redaction; that is
noted on both PRs.

---

## 3. Dispositions

### KEEP-AND-REBASE — 11, riskiest first

| Order | PR | Why it matters | Note before rebasing |
|---|---|---|---|
| 1 | **#47** | live P0: the enrichment-outcome guard **never fires on MariaDB** — `012_identity_links.sql` has no `enrichment_outcome` column, so `link.enrichmentOutcome` is always `undefined`, and `domain/identityLink.js:30-35` is still a blocklist | rebase together with #45 (same file) |
| 2 | **#45** | identity subject guard at the link layer + closed source allowlist; `rejectionCodeForProviderSubject` exists nowhere on `main` | same file as #47 |
| 3 | **#46** | largest surface; carries the open privacy-incident decision package | depends on #47/#45 landing |
| 4 | **#43** | reconciliation snapshot + identity audit; its incidental PII redaction collides with #44/#60 | re-check after #44 |
| 5 | **#35** | 018/019 replay + shared claim — the numbers `028_sso_login_attempt.sql` explicitly reserves | **its tree predates #66 and its `migrate.mjs` deletes main's seed guard** — replay only the SQL + replay stores + docs |
| 6 | #42 | report export (PDF/XLSX); half already on `main` | `package-lock.json` + `api/v1/index.js` conflicts |
| 7 | #41 | individual attendance reports | overlaps main's `reportService` lineage by purpose only |
| 8 | #39 | monthly summary | schema already on main |
| 9 | #37 | attendance engine + Agent Core decision-only | `agent/decisions.js` fights main's 2026-10-01 adapter refactor |
| 10 | #36 | slice root: effective-dated employee master | needs #34's `identityKind.js` + `nationalIdContract.js` |
| 11 | #33 | FaceScan HIP ingestion | **do this one first** as the rebase pattern — 5 conflicts, shallowly entangled |

### EXTRACT-UNIQUE-BITS-THEN-CLOSE — 5

| PR | Keep | Drop |
|---|---|---|
| #34 | 13 unique code files + `docs/SSO_PROTOCOL_EVIDENCE.md`, `HIP_ID_MAPPING_EVIDENCE.md` | the integration-branch scaffolding; its purpose is consumed by its constituents |
| #30 | 7 evidence/policy docs + `scripts/data-onboarding/*` | `013_personnel_identifier.sql`, pre-#61 `secret-scan.mjs`, `.env.example`, `.gitignore` |
| #40 | the ~36-line `agentCoreClient` fix + `criteria` handling (defects still live on `main`) | 5 memory docs identical to #38 |
| #48 | `docs/STATUS.md` rewrite + session handoff | land after #46's docs exist |
| #38 | the 2026-10-15/16 daily summaries + `PROJECT_STATE.md` | edits to main's live `DECISIONS.md` / `NEXT_ACTIONS.md` |

### CLOSE-AS-SUPERSEDED — 0

Nothing is fully redundant. Do not close anything on these grounds.

---

## 4. Unique work that must survive regardless of disposition

Closing a PR does not delete its branch, but it stops review and is what gets pruned later. These
carry irreplaceable content:

- **#46 / #48** — the open privacy incident's decision matrix, notification draft, remediation
  runbook, ADR-011, threat model. They record what was observed and decided on 2026-10-16.
- **#30** — `MJU_SSO_SUBJECT_EVIDENCE_PACK.md`, `MJU_SSO_ADMIN_REQUEST.md`: the vendor-question
  record. Cannot be reconstructed from code.
- **#34** — `SSO_PROTOCOL_EVIDENCE.md`, `HIP_ID_MAPPING_EVIDENCE.md`.
- **#35** — `SSO_VPS_DEPLOYMENT_AUDIT.md`, `SSO_SCHEMA_RECONCILIATION.md`, and the 018/019 numbers.
- **#47 / #45** — the P0 fix with its MariaDB reproduction, and the only test asserting that every
  identity source used in `backend/src` is allowlisted.
- **#43** — `IDENTITY_INTEGRATION_AUDIT.md`, `SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`.
- **#38 or #40** — the only narrative of the 2026-10-15/16 session (identical blob in both; keep one).

---

## 5. Decisions the owner must make (D-9 … D-14)

| # | Decision | Default if undecided |
|---|---|---|
| **D-9** | Land the two identity guards (**#47 + #45**) as one rebase onto `main`, ahead of any slice work? | The guard stays dead on MariaDB |
| **D-10** | Architecture: does main's `attendanceCoreClient` / `reportService` lineage stay, or does the in-repo rule engine (slices #36/#37/#39/#41/#42/#43/#46) replace it? | Seven PRs cannot sensibly be rebased before this answer |
| **D-11** | Is explicit-confirm SSO (#35) still the plan now that #66's gate exists, and are 018/019 still reserved? | 018/019 stay reserved; #35 stays parked |
| **D-12** | Is the MJU subject-contract question still live (#30's evidence pack active) or archive? | Archive: the consolidated request (`mju-sso-integration` #9) supersedes its questions |
| **D-13** | The R1/R3 privacy-incident decision (#46/#48). | Stays open; nothing notifies anyone |
| **D-14** | Approve the rebase order above, starting with #33 as the pattern? | No slice work starts |

---

## 6. What this document does not claim

- It does not claim any rebased branch still compiles: no draft's test suite was built against
  today's `main`. That is the first thing a rebase must establish.
- It does not claim the slices are wrong. It claims their green CI is **old** and their mergeability
  is measured against the wrong base.
- It changes no PR state. Everything above is a proposal; only #44 was executed.
