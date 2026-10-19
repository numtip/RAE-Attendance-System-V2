# FY2569 local import

Disposable database `attendance_fy2569_local` on the WSL2 Ubuntu MariaDB. No production host was written. Source rows are not in Git.

The prepared file matches the 2026-10-06 QA totals: 1,600 late, 24 early, 11 half-day leave, 8 withheld. All 12 fiscal months are present. Nothing outside October 2025–September 2026 was imported.

`dataperson.csv` is the identity master, joined by employee code. A code with two different names would be blocked; none were. Events whose code is absent from that file are unmatched and were not loaded. An event whose name differs from the single master row for that code was withheld.

| Result | Count |
|---|---:|
| Master people loaded | 34 |
| Unmatched codes | 19 |
| Name conflicts withheld | 5 |
| Late rows loaded | 792 |
| Early rows loaded | 13 |
| Half-day leave rows loaded | 5 |
| Attendance days loaded | 802 |
| Monthly summary rows | 0 |

Monthly summary rows were not created. The source does not contain a full present/absent calendar, so those totals were not invented. My Report lists the stored scan and leave rows for the signed-in employee.

Observed HIP-versus-monthly-report differences in `monthly_summary.csv`: 24 person-months. The narrative register describes 26. March accounts for 2 of the observed 24. Codes named for review stay withheld or mismatched as follows: 1013 has 1 withheld row, 3015 has 4 withheld rows, 1020 has 1 mismatched month, 1021 has 1 mismatched month.

A session for one loaded employee received its own report. A request for another employee returned 403. No SSO link was written.

Gate for this load: `MVP_RELEASE1_REALDATA_QA_READY` for the disposable database only. It is not production approval.
