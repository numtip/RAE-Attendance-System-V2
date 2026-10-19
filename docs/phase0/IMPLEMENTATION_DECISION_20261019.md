# Implementation decision — fast track 2026-10-19

Owner selected consolidated delivery. This record is the working choice for local code on `origin/main` `398fcd9`. It does not sign D-01–D-10 and it is not production approval.

| ID | Working choice | Still UNKNOWN |
|---|---|---|
| D-01a | New local facts use the V2 tables already on main | Live row counts |
| D-01b | No populated source is adopted. Fixtures only | Which list is the master |
| D-02 | Legacy databases stay unread by this app | Whether a lab copy can be read |
| D-03 | No synthetic MJU `personnel_id` | MJU source |
| D-04 | Real HIP field stays unverified. Fixture `facescan_id` is synthetic | Device match |
| D-05 | Day math on main stays the Attendance Core proxy. This change does not add migrations `022`–`024` | Live core URL |
| D-06 | SSO remains fail-closed | Meaning of `ac` |
| D-07 | Local example gates stay off | Host gate values and runtime SHA |
| D-08 | No host containment in this change | Whether the 2026-10-15 exposure is still open |
| D-09 | No host selected | — |
| D-10 | Report is the signed-in employee only | HR approver |

Shipped here: a self-only personal report and PDF/Excel export. A different `employeeUid`, or any `employeeId`, is rejected. A month with no stored summary and no stored rows is an empty state. Totals are omitted instead of being written as zero. Scan days that were never stored are not invented.

Review gate: `MVP_RELEASE1_READY_FOR_REVIEW`. This is not production approval.

## QA 2026-10-19

- Backend `reports`, `release1`, and `authorization` tests: 13 passed.
- Browser against the local fixture API: October 2569 shows the empty Thai message. March 2569 shows ผู้ใช้ ตัวอย่าง (E-USER), one late scan at 08:35–16:30, and ลากิจ on 10 มีนาคม 2569.
- The same session downloaded `attendance-2569-03.pdf` and `.xlsx`. A request for another employee returned 403.

## Release checklist

Local fixture QA can pass without a host. Production stays blocked until all of these are true:

1. Operator records runtime SHA and whether migrations `025` and `026` are already applied.
2. That ledger matches main's chain (`001`–`014`, then `025`, `026`). Do not apply the incident `015`–`024` chain onto it.
3. An off-host backup exists and a restore has been run on a copy.
4. Owner writes a separate production authorization.

Rollback of this change is reverting the commit. It adds no migration.
