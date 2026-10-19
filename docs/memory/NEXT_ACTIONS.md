# Next actions

**Gate:** `DAY_20261019_CLOSED — RELEASE1_IN_PROGRESS`

Tomorrow starts on PR #50, not on the incident checkout.

## First task

Finish verified-event personal reports on `feat/unified-attendance-fasttrack`:

1. Show only imported FY2569 events for the signed-in employee. Keep months with no stored rows empty.
2. Confirm PDF and Excel use the same rows, Thai labels, Buddhist year, employee code, date range, and totals.
3. Keep the import exclusions visible as counts: 19 unmatched codes, 5 name conflicts, 8 withheld review rows, and the 24-versus-26 person-month gap.
4. Re-run the focused tests: self access, cross-user denial, empty month, export, and the synthetic plan test.
5. Do not add HR or executive screens. Do not enable SSO. Do not apply migrations to any host but the disposable database.

## After that

| Order | Action | Why |
|---|---|---|
| 2 | Resolve the 24-versus-26 person-month difference from the prepared summary, counts only | The narrative and the file disagree |
| 3 | Decide whether the 19 codes absent from `dataperson.csv` stay excluded | Identity master rule |
| 4 | Owner signs or rejects D-07 and D-08, then D-02 with D-01a | Still unsigned |
| 5 | I0 containment, only with a separate approval | Host exposure was not re-checked |

## Do not do

Push to `main`, merge PR #50, open a VPS session, write a production database, or copy source rows into Git.
