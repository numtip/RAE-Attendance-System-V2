# Owner questions

Effective 2026-10-20. Unanswered items only. Release 1 work that does not depend on these continues.

## Q1. Codes absent from the identity master

| | |
|---|---|
| Blocker | 19 employee codes in the FY2569 event file are not in `dataperson.csv`. |
| Evidence | Local import on 2026-10-19. File totals are 1,600 late / 24 early / 11 half-day leave. Loaded totals are 792 / 13 / 5. **VERIFIED** counts. |
| Impact | Personal reports cannot include those codes without assigning a person. |
| Recommended | Keep the 19 codes excluded. |
| Alternatives | Owner supplies a verified code-to-person list. Until then the rows stay out. |

## Q2. Name conflicts on a single master code

| | |
|---|---|
| Blocker | 5 events use a name that does not match the one master row for that code. |
| Evidence | Same import. No code had two different names inside `dataperson.csv`. **VERIFIED** count. |
| Impact | Loading them would attach an event to a person the name does not match. |
| Recommended | Keep the 5 events withheld. |
| Alternatives | Owner confirms the master row is the person for those events. Silent code-only acceptance is not allowed. |

## Q3. 24 versus 26 person-months

| | |
|---|---|
| Blocker | The prepared summary file shows 24 person-months where HIP late/early counts differ from the monthly report. The narrative register says 26. |
| Evidence | File count **VERIFIED**. Narrative 26 is **REPORTED**. March is 2 of the observed 24. |
| Impact | The gap register cannot name the missing 2 without a new count. Report totals already use imported events, not the narrative. |
| Recommended | Use 24 as the machine-readable figure and leave 26 unresolved. |
| Alternatives | A later count-only pass with the owner. Do not invent the two rows. |

No other owner question is open for the current MVP pass.
