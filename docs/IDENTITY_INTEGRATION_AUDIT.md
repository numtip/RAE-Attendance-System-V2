# Identity Integration Audit — `mju-person-enrich` as an identity source

**Status:** `AUDIT_COMPLETE / AWAITING_REVIEW` · **Date:** 2026-10-16 · **Branch:** `feat/slice6-reconciliation`
**Target:** `G:\ProjectAI\mju-person-enrich` — **READ-ONLY. Nothing in it was created, modified, deleted or run.**
**Companion:** [`IDENTITY_MAPPING_CONTRACT.md`](IDENTITY_MAPPING_CONTRACT.md) (the design this audit feeds),
[`13_REFERENCE_PROJECT_AUDIT.md`](unified/13_REFERENCE_PROJECT_AUDIT.md) (the sibling report-generator audit).

**Labels:** **VERIFIED** (observed by a command or read in source today) · **ASSESSED** (inference) ·
**UNKNOWN** (not determinable here).

> ### สรุปผู้บริหาร (Thai abstract)
>
> `mju-person-enrich` **ใช้เป็นแหล่งอ้างอิงตัวตนอัตโนมัติไม่ได้** แต่ใช้เป็น **แหล่งเบาะแส/ตรวจสอบไขว้** ได้
> เหตุผลหลัก 4 ข้อ:
> 1. **คีย์ที่ใช้ค้นหาคือ "ชื่อ"** และ endpoint `/filter/` เป็นการค้นแบบ **คลุมเครือ** (พบ 7/308 รายการที่ชื่อ
>    ไม่ตรงกับชื่อที่ค้น)
> 2. **เมื่อเจอหลายรายการ ระบบเลือก `data[0]` ทันที** ทั้งที่ติดป้าย `ambiguous` → **ไม่ fail closed**
> 3. **เก็บเลขบัตรประชาชน 13 หลักแบบข้อความธรรมดา 303 รายการ** ในไฟล์ cache/output บนเครื่องที่ **ไม่ใช่ git
>    repo** (`.gitignore` จึง **ไม่มีผลจริง**)
> 4. **API ไม่คืน `personnelID` เลย (0/308)** → ใช้เป็น primary reference ของ kind MJU ไม่ได้
>
> **สิ่งที่ตรวจพบใหม่และสำคัญที่สุด:** เอกสารที่ให้มาชื่อ `MJU_PERSON_ENRICHMENT_KB.md` **ไม่มีอยู่จริง**

---

## 0. Required-reading check: the KB document is missing

**`MJU_PERSON_ENRICHMENT_KB.md` DOES NOT EXIST — VERIFIED (absence).**

Searched: the V2 workspace (`**/*PERSON_ENRICHMENT*` → only `docs/SSO_PERSON_ENRICHMENT_INTEGRATION.md`, a
different document), the Cursor agent stores, `G:\ProjectAI\**/*ENRICH*`, and a depth-limited recursive sweep
of `F:\projectAi`, `G:\ProjectAI\mju-person-enrich`, `G:\ProjectAI\_backups`, Documents, Desktop, Downloads
(all 0 hits). A drive-wide sweep of `G:\` ran ~80 s without a hit and was stopped — **inconclusive only for
exotic locations outside those roots**.

The only trace is a **dangling reference** in this repo: `docs/RAE_ATTENDANCE_UNIFIED_PLATFORM_BLUEPRINT_V1.md`
lists "Related local reference: `MJU_PERSON_ENRICHMENT_KB.md` (personal-data local-only policy)".

**Search coverage (2 passes).** Pass 1 (the audit workstream): the V2 workspace, the Cursor agent stores,
`G:\ProjectAI\**`, `F:\projectAi`, `G:\ProjectAI\_backups`, Documents, Desktop, Downloads — 0 hits. Pass 2
(added after this audit was written): `G:\AI` recursively, and the root-level AI/docs folders
(`G:\AI`, `G:\AI Project2026`, `G:\ai-Claude`, `G:\ai-Claude-stack`, `G:\Antigravity`, `G:\CodexSand`, `G:\DocF`,
`G:\docs`, `G:\GIthub`, `G:\Git`, `G:\CrystalReport`) to depth 3 — **0 hits for `ENRICH`**. A full-drive
recursive sweep of `G:\` and `F:\` was attempted twice and abandoned (it exceeded ~165 s without completing),
so exotic locations outside the roots above remain **UNKNOWN**, not proven absent.

**A related document set WAS found in pass 2, and it matters** — see §0.2.

**Consequence:** the "personal-data local-only policy" this audit was asked to read is **undocumented at
source**. Any policy statement attributed to it would be invented. Recorded as gap **A0**.

## 0.2 Related documents found (they are not the KB, but they are binding)

`G:\AI\docs\integrations\` holds **8 documents dated 2026-05-20**: `MJU_API_GOVERNANCE_POLICY.md`,
`MJU_API_DB_SCHEMA.md`, `MJU_API_INTEGRATION_PLAN.md`, `MJU_API_PLATFORM_ARCHITECTURE.md`,
`MJU_API_ADMIN_WORKFLOW.md`, `MJU_API_OPERATION_RUNBOOK.md`, `MJU_API_PLATFORM_WITNESS.md`,
`MJU_API_SERVICE_PORTAL_BLUEPRINT.md`.

**Labelled honestly:** these are **summaries, recommendations and plans** for a *different* consumer (a RAE
Next.js app), **not** the MJU Person API's OpenAPI spec. They do **not** list the person API's fields, so they
do **not** answer §1.1/ID-5 (whether a stable `personnelID` exists) and they do not settle whether `/filter/`
is exact or fuzzy.

**What they DO establish, and why it changes this audit's conclusions:**

* `MJU_API_GOVERNANCE_POLICY.md` states that *"all requests for personal/sensitive data require **DPIA and
  privacy officer sign-off**"* and that sensitive endpoints need **multi-stakeholder approval (Admin + Data
  Owner + Privacy Officer)**; it requires **MFA** for Admin/DataOwner, **tokens rotated in Secret Manager**,
  **quarterly access reviews**, **annual audits**, **data minimisation**, **PII redaction in logs** and
  **restricted PII export**; and it requires every endpoint to have an **assigned owner and a documented
  OpenAPI spec**.
* `MJU_API_INTEGRATION_PLAN.md` requires all MJU API calls to be **server-side only**, credentials from
  environment only, and **`Cache-Control: no-store`** for personal-data responses.
* `MJU_API_DB_SCHEMA.md` is a **"recommended"** platform schema (requests / clients / token metadata / audit
  logs / endpoint catalog / access policies / rate limits) — it does not describe the person API.

**Net effect:** the data-protection gate (§7 below, and contract **G7**) is **documented as a requirement**
rather than merely absent, and there is now a concrete, citable approval path. No evidence of a *completed*
DPIA or a registered client was found. The gate does **not** lower: these are proposals, not approvals.

## 0.1 Method, PII handling and a disclosure

* Inspection was **source-text and metadata only**: file names, sizes, row counts, column-header names,
  uniqueness/null counts, and masked shapes (`****NNNN`). **No personal value was reproduced** in this
  document, in the contract, in any fixture or in any commit.
* No script was executed; the MJU API was never called; `npm install` was not run; `.env` was never opened
  (only its **key names** were listed — exactly one key, `MJU_API_TOKEN`; the value was never read printed,
  copied or hashed).
* **Disclosure (not hidden):** during an automated "print the first line's column names" probe, one probe
  printed a header line that turned out to contain PII — the first line of an audit `jsonl` (a real full name)
  and, for two `output/` files, a **raw 13-digit National ID used as the header line**. Those values reached
  tool output before the shape was known. **No value is reproduced anywhere in this deliverable**, and the
  affected values are shown masked. This accident is itself evidence for finding **F6** (below): these
  artifacts **cannot be safely auto-scanned**, because a "header" and a "data row" are not reliably
  distinguishable.

## 1. API contract — what the code actually calls

**VERIFIED** — identical across all four enrich scripts (`enrich-mju-person.mjs`, `enrich-name2-citizen-id.mjs`,
`enrich-name2-citizen-id-v2.mjs`, `enrich-name3-citizen-id.mjs`).

| Aspect | Value |
|---|---|
| Base URL / path | `https://apis.mju.ac.th` + `/person/v1/filter/{firstName}/{lastName}`, URL-encoded |
| Method / auth | `GET`; `Authorization: Bearer <MJU_API_TOKEN>` |
| Timeout | 10 000 ms via `AbortController` |
| Retry | up to 3 retries (4 attempts) on **any** error, including non-2xx |
| Backoff / rate limit | 1s/2s/4s; a single 200 ms delay per row |
| Error mapping | `AbortError` → `timeout`, else `api_error`; non-2xx → `API Error: <status>` |
| 401/403 handling | **none** — a rejected token is retried 3× then recorded as `api_error` |
| Response shape | **top-level JSON array** of person objects (confirmed against a 308-record on-disk cache) |

**Observed record fields (46 keys, present in 308/308):** `citizenID`, `titlePosition`, `firstName`,
`lastName`, `titleNameEn`, `fistNameEn` (sic), `lastNameEn`, `bloodType`, `gender`, `nationId`, `nation`,
`positionCode`, `personnelTypeId`, `personnelType`, `positionTypeId`, `positionType`, `positionId`,
`position`, `positionLevelId`, `positionLevel`, `retiredYear`, `sectionId`, `section`, `divisionId`,
`division`, `facultyId`, `faculty`, `adminPositionId`, `adminPositionType`, `adminPosition`,
`educationLevelId`, `educationLevel`, `titleEducation`, `major`, `university`, `countryId`, `country`,
`e_mail`, `positionEn`, `personnelPhoto`, `startEducationDate`, `graduateDate`, `disciplineGroupId`,
`disciplineGroup`, `startDate`, `retiredDate`, `studyTypeName`.

### 1.1 Fields the code reads vs. fields that exist — the decisive table

| Field the code reads | Exists in the response? | Consequence (**VERIFIED**) |
|---|---|---|
| `citizenID` | **yes** (308/308, 13 chars) | populated |
| `personnelID` | **NO — 0/308** | **always empty.** The MJU kind cannot be populated from this API |
| `email` | **NO.** The API field is `e_mail` | **every output e-mail is silently empty** |
| `personTypeName` | **NO** — not in the field list | always empty |
| `firstName` / `lastName` | yes (308/308) | populated |
| `faculty`, `position` | yes (308/308) | present but **not read** by the live script |
| `nationId` | yes (308/308) | a **second** national-ID-like field, never compared with `citizenID` |

Every consumed field is read through `|| ''` or optional chaining, so **absence is coerced to an empty string
and written to the CSV with no error**. V2's own `docs/IDENTITY_CONTRACT.md` already records part of this
(U8, and "Not observed in cache").

### 1.2 Documentation is not the code (two distinct traps)

1. **The README's script is a stale copy.** `README.md:18` contains a leaked shell heredoc
   (`EOFcat << 'EOF' > scripts/enrich-mju-person.mjs`) followed by an embedded ~185-line copy of the script
   whose output row has **10 columns**. The **live** `scripts/enrich-mju-person.mjs:154-159` writes **4
   columns** (`firstname, lastname, citizen_id, email`). Anything written from the README describes the wrong
   schema. *(This audit's first pass made exactly that mistake and was corrected by reading the live file —
   recorded because it is the failure mode this repo keeps hitting: trusting the document over the code.)*
2. **The documented API test is a no-op.** `README.md:12` documents `node scripts/test-api.mjs` as the way to
   verify the API; **`scripts/test-api.mjs` is 0 bytes — VERIFIED.** The documented verification path
   verifies nothing.

## 2. The lookup key — a name, fuzzily matched, ambiguity resolved silently

**The join key is `firstName` + `lastName` — VEIFIED.** The cache key is literally
`` `${firstName}|${lastName}` `` and the same pair is URL-encoded into the filter path.

* Name parsing is a **naive whitespace split** (first token = first name, rest = last name), with no registry
  normalisation. The `-v2` script adds Thai-title stripping and **fallback re-queries** under alternative
  splits, including a **`firstname_only` attempt that sends an empty last name** (15 of 196 audit rows).

**2a. The endpoint is FUZZY, not exact — VERIFIED.** In the cache, **7 of 308** returned records carry an API
`firstName`/`lastName` that **differs from the name that was queried** (7 first-name, 2 last-name mismatches).
The code **never checks** that the returned name equals the queried name.

**2b. Ambiguity FAILS OPEN at the artifact level — VERIFIED.**

```js
status = 'ambiguous';
stats.ambiguous++;
enrichedData = result.data[0];     // the first element wins; nothing orders or compares candidates
```

Same pattern in all four scripts. The row is *labelled* `ambiguous` — a hook a careful consumer could filter
on — **but it still carries a concrete `citizen_id` taken from the first array element, persisted to the
output CSV.** Which record "wins" is whatever order the API returned.

**Ambiguity is real, not theoretical — VERIFIED:** exactly one cached query returned 2 records, and those two
records carry **two different `citizenID` values** (two different people). The code still emitted the first
one's national ID, and the output row records `status=ambiguous, match_count=2` **with a 13-digit id present**.

**2c. The output wraps the identifier in a spreadsheet formula — VERIFIED.**

```js
citizen_id: enrichedData.citizenID ? `="${enrichedData.citizenID}"` : '',
```

This is the classic "force Excel to treat it as text" hack, and it is applied to an **unvalidated** value
(§4). It is the **opposite** of the posture this repo chose for its own exports (R-03 writes numbers/strings
so that Excel reports `HasFormula=False`). Any V2 path that ingests this must **not** adopt the convention:
a formula in a spreadsheet is executable content. Recorded as ingestion rule **I9**.

## 3. Caching and at-rest exposure

**Cache — VERIFIED:** `logs/person-cache.json`, ~633 KB, 387 top-level keys (every value an array),
**308 person records** (length distribution `{0:80, 1:306, 2:1}`).

* The **cache key is a person's name in plaintext** (16 keys have an empty last name).
* It persists the **entire API record** — raw `citizenID` (**303 distinct, all 13 chars, none empty**),
  `e_mail`, a `personnelPhoto` URL, `nationId`, org units, dates. **Raw National IDs at rest, plaintext,
  un-hashed.**

**Other at-rest artifacts — VERIFIED:** three `output/` CSVs hold raw 13-digit `citizen_id`
(one file has **no `status` column at all**, and **43 of its 177 rows have an empty id** — indistinguishable
from "not run yet"); **two more files have a raw 13-digit National ID as their header line** (masked here:
`****0582`); an audit `jsonl` persists names; `backup/` holds copies of the name inputs; `run.log` may contain
script stdout, and **the scripts print names to stdout**, so PII reaches the console and any terminal log.

**The `.gitignore` is INERT — VERIFIED, and this is the core exposure finding.**

`.gitignore` does cover `.env`, `input/*.csv`, `output/*.csv`, `logs/`, `*.log`. But:

1. **The directory is not a git repository.** Nothing is ignored because there is no index. The file expresses
   *intent only*, while the README's privacy note claims protection that does not exist in practice.
2. Several artifacts are **not even listed**: `input/prompt1.MD`, `output/*.txt` (only `*.csv` is matched),
   and **`backup/` (two CSVs of real names)**.
3. **Protection is OS-account-only.** Whoever can read the folder can read 303 plaintext National IDs, names
   and e-mail addresses. There is **no HMAC layer, no encryption, no access log, and no version history** —
   so which script and which run produced any given output file is **not determinable**.

## 4. Identity field trustworthiness

| Field | Required by code? | Validated? | Can it be empty? | Verdict |
|---|---|---|---|---|
| `citizenID` | effectively, but **not enforced** — no row is dropped when absent | **Shape only, and only in a post-hoc report** (`length === 13 && /^\d+$/`). **No checksum. No uniqueness check.** | yes — though 0/308 empty in the observed cache | **VERIFIED** populated & 13-char; **UNVERIFIED** that it is the right person |
| `personnelID` | no | no | **always (0/308)** | **VERIFIED absent** |
| `email` | no | no | **always** (field does not exist; the API returns `e_mail`) | **VERIFIED always empty** |
| `faculty` / `position` | not read by the live script | no | could be empty | present 308/308 |
| `nationId` | not read | no | unknown | present 308/308; **never compared with `citizenID`** |

**The only validation anywhere** is a "Verification" block that splits lines on `,` (not a real CSV parse) and
**prints** `OK`/`ISSUES` **without failing the run, dropping rows or exiting non-zero**. Two of the four scripts
have no validation at all.

**Authoritative vs candidate:** nothing here is authoritative. **`citizenID` is candidate evidence only** —
its *presence* is verified, but that it means "this is that person" is not provable from this source.

**UNKNOWN:** whether `citizenID` is the authoritative Thai citizen identifier; whether it is unique per human;
what `nationId` is; whether either matches the MJU SSO subject.

## 5. Duplicate, conflict and code-reuse handling

**There is no duplicate, conflict or collision detection anywhere — VERIFIED.**

* **One identifier under two different names:** two `citizenID` values appear under **more than one distinct
  query key**. Nothing compares a new id against previously seen ones, so **both rows are written** and the
  conflict is invisible. This would contradict V2's `UNIQUE(id_type, id_value)` intent.
* **Duplicate records in the cache:** 308 records → **303 distinct** `citizenID`.
* **Multi-person results:** counted, labelled, then resolved to `data[0]` (§2b). Not quarantined.
* **Nulls:** coerced to `''`; nothing filters or flags an empty `citizenID`.
* **Re-run duplication:** the output is opened with `flags: 'a'` and a header is written only when the file is
  empty — so **a re-run appends a second full copy of the rows**. No truncate, no row identity.
* **Resume path:** one script skips rows already present in its output (keyed on the name), so a
  **changed or incorrect prior row is never re-queried** — stale results persist.
* **Automatic linking: none, and it is structurally impossible here** — there is no DB client, no crypto and no
  HTTP server in `package.json`. The tool **cannot** write to a database. This is the one clean bill of health.

## 6. ID-card mapping feasibility with HIP / FaceScan and V2 — without exposing values

The task asks whether this source can bridge the ID card ↔ HIP/FaceScan ↔ V2 chain. **ASSESSED** from the
verified findings above:

| Bridge | Feasible today? | Why |
|---|---|---|
| `citizenID` → `employee_uid` | **only as corroboration** | V2 already resolves this itself by HMAC lookup. This tool can at most supply an **equality cross-check**, which is exactly how V2's existing `verify-idcard-enrich.mjs` uses it (index by id, compare by equality — **not** by name). |
| `personnelID` → `employee_uid` | **NO** | The API returns no `personnelID` (0/308), so the MJU kind's primary reference cannot be populated from here. |
| name → `employee_uid` | **NO — prohibited** | Violates Policy S9 and the standing "never match by name or email" rule. The endpoint is also fuzzy (§2a). |
| `citizenID` → `facescan_id` | **NO** | FaceScan ids come from the HIP export; this API knows nothing about them. The HIP↔national-id bridge is V2's own protected mapping. |
| Ambiguous/exact-match discrimination | **NO** | Ambiguity fails open (§2b), so the artifact cannot be trusted to distinguish one person from two. |

**Conclusion: this source can corroborate an identity V2 has already established. It cannot establish one.**
That is a genuine, useful capability — and it is far narrower than "identity source".

## 7. Gaps vs this project's policy

| Policy requirement | Satisfied here? | Evidence |
|---|---|---|
| Linkage only via a **protected keyed National-ID lookup (HMAC-SHA-256, key versioned)** | **NO** | No `node:crypto` import, no crypto dependency, no HMAC, no key version concept. Raw ids in plaintext on disk. |
| **"Names and e-mail never match"** | **NO — structurally violated** | The entire lookup *is* a name join; the join key is `` `${first}|${last}` ``. |
| **Ambiguous / unapproved links FAIL CLOSED** | **NO at the artifact level** | `ambiguous` rows still carry `data[0]`'s `citizen_id`. |
| **No automatic linking** | **YES (vacuously)** | No DB/API write path exists; it is an offline batch. |
| **SSO must not auto-approve an identity link** | **YES — but by V2, not here** | This project has no SSO code at all. The boundary is enforced in V2 (`enrichmentBlocksApproval`, `IDENTITY_NOT_APPROVED`, candidate→operator approval). |
| A **stable** identifier to anchor identity | **NO** | `personnelID` is absent; the only anchor is a fuzzy name. |

## 8. Recommended architecture

**`mju-person-enrich` is a CANDIDATE / CORROBORATION-ONLY source. It must not be an authoritative identity
source, and its raw artifacts must never enter V2 or any approval path as-is.** Detail and the ingestion
contract: [`IDENTITY_MAPPING_CONTRACT.md`](IDENTITY_MAPPING_CONTRACT.md) §3.

Permitted use (all five required):
1. **Offline, local, one-way equality check** — consume **only** `citizenID` **equality** against V2's own
   HMAC digest, inside a controlled local script, exactly as V2's existing verifier does. Never consume names.
2. **Hash before anything is written** — the tool's plaintext cache/output must never be copied into V2, a PR,
   a fixture, a log or Agent Core. Any derived artifact carries a digest, never a raw id.
3. **Drop every non-`found` row** (`match_count != 1`), and **remove the `data[0]` fallback** from all four
   scripts before this tool is trusted for anything automated.
4. **Quarantine conflicts** — one `citizenID` under two names is a human-review event, never a link.
5. **Keep it off the runtime path** — it must never run on an SSO callback or any request path.

**Evidence required before automated linkage could even be considered:** a written MJU API contract (exact vs
partial match; the real field list; whether any endpoint returns a stable `personnelID`); a **stable, unique**
person key; fail-closed ambiguity in the scripts; a versioned HMAC layer applied before disk; a
version-controlled, access-controlled, hashed artifact store; and written acknowledgement of a data-protection
basis for receiving citizen IDs at all.

## 9. Findings, ranked

| # | Severity | Finding |
|---|---|---|
| **F1** | **critical (design-blocking)** | **The API returns no `personnelID` (0/308).** V2's MJU kind requires `personnel_id` with `source_system='mju_person_api'`, so **this endpoint cannot populate the MJU identity kind**. Whether another endpoint returns one is unknown. |
| **F2** | **critical (correctness)** | **Ambiguity fails open**: the row is labelled `ambiguous` yet still carries `data[0]`'s national id. A real 2-record case with **two different ids** exists in the cache. |
| **F3** | **critical (PII at rest)** | **303 plaintext National IDs** + names + e-mail in a cache and outputs, on an **unversioned, non-git** directory where `.gitignore` is **inert**; several sensitive paths are not even listed, and the README claims protection that does not exist. |
| **F4** | **high (unreliability)** | **The filter endpoint is fuzzy** (7/308 name mismatches) and the code never verifies the returned name matches the query. A name match is therefore not reliable evidence. |
| **F5** | **high (identity validity)** | **No checksum, no uniqueness, no cross-record comparison.** One `citizenID` was observed under two different names; 308 records contain 303 distinct ids, undetected. |
| **F6** | **high (safety)** | **The artifacts cannot be safely auto-scanned**: two output files have a **raw National ID as the header line**, and one file has no `status` column while 43/177 rows are empty — a "header" is not distinguishable from a "data row". |
| **F7** | medium (injection) | The output writes `citizen_id` as the spreadsheet formula `` ="<id>" `` around an **unvalidated** value — the pattern V2's own export layer deliberately avoids. |
| **F8** | medium (documentation) | **The README is not the code**: it embeds a stale 10-column script (the live one writes 4 columns) behind a leaked heredoc, and documents an API test that is a **0-byte no-op**. |
| **F9** | medium (process) | **Not a git repository** — no history, no provenance, no way to tell which run produced which artifact; re-running **appends duplicates**; the resume path **never re-queries** a changed row. |
| **F10** | medium (missing input) | **`MJU_PERSON_ENRICHMENT_KB.md` does not exist** (§0), yet is referenced as required reading and as the "personal-data local-only policy". || **F11** | low (hygiene) | PII reaches **stdout** and therefore any terminal log; `nationId` is a second national-ID-like field that is never compared with `citizenID`. |
| **F12** | medium (governance) | **An MJU API governance policy exists on this machine and requires a DPIA + privacy-officer sign-off, multi-stakeholder approval, MFA for Admin/DataOwner, Secret-Manager token rotation, quarterly access reviews and a per-endpoint owner + OpenAPI spec** (§0.2). **No evidence of a completed DPIA or a registered V2 client was found.** Any integration must satisfy these first — they were not previously cited in V2's documents. |

## 10. Open questions

1. Is `/filter/` exact or fuzzy? Evidence says fuzzy; no API documentation was read.
2. Does **any** MJU endpoint return a stable `personnelID`? (V2 lists this as U7.)
3. Is `nationId` the same system as `citizenID`, or a different identifier?
4. For the observed id-under-two-names conflict, **which record is correct?** Not decidable from this source.
5. Which script/run produced the two id-as-header output files? Undeterminable (no history).
6. Was the README's 10-column script ever the live version?
7. Do `run.log` / `run_personnel.log` contain names? (Not read, by instruction — assessed as likely.)
8. What is `input/prompt1.MD` (290 lines, not gitignored) and how does it relate to the pipeline?
9. Where is `MJU_PERSON_ENRICHMENT_KB.md`?

## 11. Declaration

This audit **changed nothing** in `G:\ProjectAI\mju-person-enrich`: no file created, edited, deleted or run;
no API call; `.env` never opened (one key **name**, never its value); no secret, token or national ID
retrieved or reproduced. **No personal value from that project appears in this document, in the contract, in
any V2 fixture, in any commit, or in any Agent Core call.** Agent Core was **not** consulted for this
subsequent workstream (the session's one-call budget was already spent by the session's opening consult).
Every figure quoted here is a count, a size, a column name or a masked shape.
