# Private batch directory, dry-run plan, and source status (read-only discovery, 2026-10-09)

Gate: **BLOCKED** until host, authoritative source, and 34-person scope are confirmed by a human. No import, migration, deploy, or SSH was performed.

## Host evidence
- `README.md` / `docs/PROJECT_DIRECTION.md`: VPS **`10.1.245.190`** is the host for recovery, production validation, live SSO QA, and cutover (VPS-last).
- `docs/DB_RECOVERY_EXECUTION_RUNBOOK.md` calls the same host a **lab/recovery workstation — "not the live app runtime"**; the live runtime host for `raeservice.mju.ac.th` is not named in any doc (`RELEASE1_FINAL_SIGNOFF.md`: production host `BLOCKED_EXTERNAL`).
- Operator SSH config has alias `RAE_245190` -> same IP; `VPS_254237` and others are unrelated/unknown. Alias names alone are not proof.
- `docs/AGENT_CORE_POLICY.md`: no SSH to VPS without a documented VPS gate. => **Host unconfirmed for batch preparation; needs human confirmation + gate.**

## MJU source status
- `G:\ProjectAI\mju-person-enrich` is local-only (not a git repo), `.env` holds the API token (not read), inputs/outputs/logs gitignored. It enriches by **person name** -> `citizen_id` + `email`; it does **not** return `personnel_id`, and name matching is not sufficient for linking.
- Prior runs: name2 180 rows (166 found, 13 not found, 1 ambiguous), name3 95 rows (86 found, 9 not found), personnel 177 rows (134 found).
- No authoritative MJU Person batch with `personnel_id` exists locally. `docs/SSO_SUBJECT_CONTRACT_INTEGRATION_CHECKLIST.md` says enrich must never run on the callback path.

## 34 vs 50 (masked counts only)
- IDCard CSV: 52 rows -> 50 unique national IDs / 50 FaceScan IDs; 2 exact-duplicate groups; 0 conflicts (sha256 of file in `database/local/` report).
- Of the 50, **21** national IDs appear in any mju-person-enrich output (name2 16, name3 12, personnel 4, overlapping). 29 have no MJU-enrichment evidence.
- The figure **34 has no real evidence source**: it appears only as the synthetic fixture shape (`SSO_ONBOARDING_PROGRESS_2026-10-02.md`: "synthetic 50-person shape", `PERSONNEL_ID_ONBOARDING_DESIGN.md`). It does not match 21, 50, or any enrichment report.
- The remaining 16 are **not** assumed to be hold; they are "scope undefined". Needed from a human: the approved list/criteria and its source (document, ticket, or approver).

## Private batch directory design (not created)
- Host path (after approval): `/var/lib/rae-onboarding/batches/<batch_id>/`, owner `rae-onboard:rae-onboard`, dir `0700`, files `0600`, outside web root and repo; no copy to cloud sync/Git; `umask 077`.
- Access: only the named operator account via SSH key; sudo not required; access logged by `auditd` / shell history on the host.
- Contents: `source/` (read-only copy of approved inputs), `prepared/<batch_id>.preview.json` (no raw ID; HMAC + key version), `reports/` (masked), `SHA256SUMS`.
- Integrity: `sha256sum` of every input and output recorded in `SHA256SUMS` and in the approval report; re-verified before any import.
- Keys: supplied via `*_FILE` mounts readable only by the operator account; never written to the batch dir.

## Dry-run plan (after gates clear)
1. `node scripts/data-onboarding/prepare-import-batch.mjs <person-batch.json> --write-local --require-keys` (exit 2 on key config error; output is masked, writes `.local/import-batches`, point cwd to the private dir).
2. Review: ready/hold counts, hold reasons, identifier conflicts (must be 0), employee-id range, checksum, `rollback_key_count`.
3. QA: unique count equals the **human-approved** count; any identity conflict or count mismatch => BLOCK.
4. Run `database/preflight/015_preflight.sql` on a copy/staging DB (not production) and record results.
5. Produce the masked approval report; STOP at `HUMAN_IMPORT_APPROVAL_REQUIRED`.
