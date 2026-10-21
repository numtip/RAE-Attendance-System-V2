# NEXT STEPS — from 2026-10-21

**Current gate:** `DAY_20261021_CLOSED_WITH_SECURITY_FOLLOWUP`
**Production:** **FROZEN** — no deploy, host migration, import or SSO activation.
**Open P0:** national ID in public `origin/main` source **and** history — **not resolved**.

Exact restart instructions are at the bottom. Everything above them is either an owner decision or a verification
step; do not substitute invention for either.

---

## 1. FIRST — the P0 (owner decision, then one merge)

`docs/security/NATIONAL_ID_INCIDENT_20261021.md`.

| Order | Action | Owner needed? |
|---|---|---|
| 1 | **`S2`** — approve merging **PR #60**. It is the only change that removes the value from `main`'s **source** and adds the guard that stops it recurring. | **yes** |
| 2 | After the merge, verify mechanically against the **ref**, not a working copy: scan `origin/main`, canonicalise every 13-digit candidate, test the checksum, expect **0 files**. A scan that reads ~0 files is a failure, not a pass. | no |
| 3 | **`S1`** — history remediation: rewrite, or accept-and-contain with a written rationale. **Nothing may be rewritten before this.** | **yes** |
| 4 | **`S3`** — who performs the PDPA notification assessment. | **yes** |

**Do not** mark the incident resolved on the strength of an unmerged PR or an unverified rewrite. The trap is
recorded: the introduction commit on `main` is `3244553`, **not** `83aaa53`; a rewrite keyed on the latter leaves
the value public while appearing to succeed.

---

## 2. SECOND — land the four open PRs

All four are `MERGEABLE` with **8/8** CI. Each needs an explicit owner approval; none may be merged by an agent.

| Order | PR | Why this position |
|---|---|---|
| 1 | **#58** `fix/derived-employee-uid` | independent, no schema dependency |
| 2 | **#60** `F9 national-ID HMAC` | independent of the schema for non-national identifiers; contains the P0 value |
| 3 | **#59** `SSO signout hardening` | independent |
| 4 | **#61** `migrations 015–024` | schema only. Merging is CI-safe; **applying** is not (see §3) |

If security outranks tidiness, **#60 first**.

---

## 3. THIRD — reconcile the schema before any host apply (blocks #61's *application*)

Merging #61 is safe. **Applying** it is not, until these are fixed:

1. **`015_facescan_hip_ingestion` DROPs `014`'s staging tables** and re-creates them with different column names.
   `main`'s `facescanRawMariaDbRepository` still selects `facescan_import_batches.id`/`finished_at`/`committed`
   and `staging_facescan_raw.payload_json`/`scan_datetime`/`batch_id`. FaceScan raw ingestion breaks the moment it
   is applied. **Irreversible — no rollback exists.**
2. **`016_attendance_events` has no rollback at all.**
3. **Rollback ledger trap:** `025`/`026`/`017`/`020–024` down-scripts do **not** delete their ledger row, so after
   a rollback the runner prints `skip` while the tables are gone. Reproduced. An operator must delete ledger rows
   by hand.
4. **`026_refresh_token_family.down.sql` is not idempotent** (`ERROR 1091` on re-run).
5. **Preflights must run first**, on the target engine: `database/preflight/015_preflight.sql` and
   `017_preflight.sql`. Skipping them on a DB holding legacy plaintext national IDs or duplicate employee-days
   aborts mid-file with no ledger row.

---

## 4. FOURTH — the owner inputs that block all 54 import rows

Unchanged from 2026-10-20 except where noted. **0 of 54 rows are import-ready.**

| ID | Needed | Note |
|---|---|---|
| **O-6 / F5** | verified `effective_from` per person, or an approved documented policy | blocks **all 54** rows; no such source exists on this machine |
| **O-7 / F6** | confirmed names for `1013` and `1015` | 2 rows |
| **O-8 / F9** | approve the national-ID path end-to-end | the HMAC contract is implemented in #60 but unmerged |
| **O-9 / R-F4a** | approve `027` **after** disposable-MariaDB evidence | proposal-only in `docs/proposals/`; **not** in `database/migrations/` |
| **F10** | may the HIP code serve as `employee_id` for `1015`, or must a code be supplied? | 1 row |
| **O-4** | confirm `name` = given, `c_name` = family | 3 artefacts agree, 0 counter-examples, nothing documented |
| **O-5** | the current spelling for code `2017` | single non-homophone character; no automatic choice permitted |
| **M1** | approve the migration order and the fate of `015_facescan`'s destructive `DROP` | blocks applying #61 |

Carried and **still unresolved**: the 19-code `dataperson.csv` exclusion (D-2026-10-20-09) and the 24/25/26
discrepancy counts (D-2026-10-20-08).

---

## 5. FIFTH — SSO live test (owner coordination)

Stopped at **`SSO_LIVE_TEST_REQUIRED`**. Before any live call:

1. **Vendor confirmation** of the contract: the `ac` parameter name, the token endpoint body, whether a client
   secret exists, whether `state` is round-tripped. The sample shows `ac` + `{clientID, code}` and **no** secret —
   that is not OAuth 2.0, and RAE V2 currently hard-blocks the portal path with `SSO_NOT_READY`.
2. **F9 must be settled first** — a live callback that resolves by national ID on today's `main` would reach a
   schema that stores plaintext.
3. Cheapest first step: `SSO_CALLBACK_DIAGNOSTIC=true`, which captures the real query contract (field names and
   lengths only) and exposes no personal data.

---

## 6. Do not do

- Do not rewrite history, force-push, or delete evidence without `S1`.
- Do not merge #58–#61 without explicit owner approval.
- Do not apply #61 to any populated database before §3 is resolved.
- Do not commit `database/roster_rae2027.csv`, `database/local/**`, `IDCard*` files, any HIP export, or any key.
- Do not reproduce `****5351` in any encoding, in any artefact.
- Do not add `027` to `database/migrations/`.
- Do not invent a date, name, code or identifier to unblock anything.
- Do not drop `stash@{0}`, `stash@{1}` or `G:\ProjectAI\_backups\`.

---

## 7. Exact restart

```powershell
cd G:\ProjectAI\rae-attendance-system-v2
git.exe status -sb            # expect: dirty incident checkout, 10 modified, 0 deleted
git.exe stash list            # expect: 2 stashes — never delete
git.exe rev-parse HEAD        # expect: 039c4e0
git.exe rev-parse origin/main # expect: 2770657 (or the EOD merge SHA, if this closeout was merged)

# Jev: once, advisory only
. .\agent\scripts\use-live-credentials.ps1
node agent\scripts\live-smoke.mjs

# DB work (owner-directed): WSL2 distro on G:
wsl -d Ubuntu-22.04-G -- bash -lc "mariadb -N -e 'SELECT VERSION()'"   # expect 10.6.23
```

Then read, in order: `docs/reports/EOD_2026-10-21.md` → `docs/security/NATIONAL_ID_INCIDENT_20261021.md` →
`docs/memory/SESSION_2026-10-21.md` → this file.

**First action of the next session is not code.** It is asking the owner for `S1`/`S2`.
