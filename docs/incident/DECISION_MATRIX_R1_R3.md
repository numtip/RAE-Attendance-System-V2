# Decision matrix — R1 (notification) and R3 (history remediation)

**Status:** `OPEN — DECISIONS PENDING. NOTHING APPROVED BY THIS DOCUMENT.`
**Prepared:** 2026-10-16 (Asia/Bangkok) · **Incident reference:** `PII-IN-FIXTURES-20261016` ·
**Authoritative record:** [`../SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`](../SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md)

> **Every row below is a DECISION FOR A HUMAN.** This document recommends defaults; it does not take decisions,
> does not give legal advice, and does not close the incident. The incident remains `OPEN` for **R1** and **R3**
> until the rows marked `DONE` say so — and none does today.

**Label legend:** **VERIFIED** · **REPORTED** · **UNKNOWN**. **Status** per row: `OPEN` (undecided) · `BLOCKED` (waiting on another row) · `DONE`.

---

## 1. The decision gate at a glance

| ID | Decision | Owner | Status | Recommended default |
|---|---|---|---|---|
| **D1 (R1)** | Whether to notify, and whom | Owner + privacy officer / legal | `OPEN` | Notify the **privacy officer** (direction) **now**; **do not** notify the individual until legal says so |
| **D2 (R3)** | Which history-remediation option | Owner (privacy officer consulted) | `OPEN` | **(b) `git filter-repo` on a fresh mirror clone**, run only under the preconditioned runbook |
| **D3** | Whether to make the repository private | Owner | `OPEN` | May be taken **as containment only**; **not** as remediation |
| **D4** | Whether to add a pre-commit / CI secret-and-PII gate beyond the existing checks | Engineering + owner | `OPEN` | **Yes, cheap and durable** — extend the R4 guard to a shared pre-commit + CI gate |
| **D5** | Whether the affected individual's MJU Person API data needs a consent / data-protection-basis review (link **G7**) | Owner + privacy officer | `OPEN` | **Yes — begin the DPIA + sign-off path that contract G7 already requires** |
| **D6** | Whether to close the incident | Owner | `BLOCKED` (on D1–D3, D5) | Keep `OPEN`; close only when V1–V10 in the runbook hold |

**Dependency order:** D1 and D3 can be taken immediately. **D2 must not be executed before D1/D3's input is
recorded and the runbook pre-flight (P1–P13) is complete.** D5 is independent and should start in parallel,
because a rewrite does not answer the data-protection-basis question.

---

## 2. D1 (R1) — notification: whether and whom

| Field | Content |
|---|---|
| **The decision** | Given a real individual's national ID was publicly exposed (and remains in history), do we notify: (i) the privacy officer, (ii) the affected individual, (iii) a regulator, and on what timeline? |
| **Who owns it** | **Owner** decides; **privacy officer / legal counsel** advise. **Not an engineering decision** (incident §4.3). |
| **What it unblocks** | Whether a rewrite is required or optional (D2); whether the incident can be closed (D6); whether any regulator clock has started. |
| **Options** | (a) Privacy officer now, individual only if legal requires. (b) Privacy officer now **and** the individual proactively. (c) Privacy officer now, regulator if legal requires. (d) None. |
| **Risk of each** | (a) **low** — correct first step; keeps the individual's decision with legal. (b) **medium** — an unjustified notification is itself a disclosure, and it is irreversible; do not send "to be safe". (c) **medium** — misses a mandatory clock if wrong; requires legal confirmation. (d) **high** — ignores an incident that is public and ongoing. |
| **Recommended default** | **(a): route the privacy-officer request now** using `PRIVACY_NOTIFICATION_DRAFT.md` Variant A; **hold Variant B** (individual) until legal decides. |
| **Status** | `OPEN` — draft prepared ([`PRIVACY_NOTIFICATION_DRAFT.md`](PRIVACY_NOTIFICATION_DRAFT.md)); **not sent**. |
| **Facts it rests on** | Value checksum-valid + byte-identical to a real MJU `citizenID` (REPORTED); public on `main` since **2026-10-02** (VERIFIED); still exposed in history (VERIFIED); person **not** in RAE scope, no other personal data exposed (REPORTED). |
| **UNKNOWN that would change it** | whether anyone cloned/forked (no telemetry); the applicable legal thresholds and timelines (legal question). |

---

## 3. D2 (R3) — which history-remediation option

| Field | Content |
|---|---|
| **The decision** | Which of options (a)–(f) in [`HISTORY_REMEDIATION_OPTIONS.md`](HISTORY_REMEDIATION_OPTIONS.md) do we take to remove the value from public history — or do we accept and document the exposure? |
| **Who owns it** | **Owner.** The privacy officer's input (D1) may constrain the answer; engineering only executes. |
| **What it unblocks** | Closing the incident (D6); whether collaborators must re-clone; whether the PR stack #41–#45 is re-created or written off. |
| **Options** | (a) do nothing + document · (b) `filter-repo` + force-push · (c) `filter-branch` · (d) BFG · (e) rotate repository · (f) make private. |
| **Risk of each** | (a) **exposure continues** · (b) **high blast radius**, PR-stack loss, but the only in-place removal that preserves this workspace's stashes/backups by construction · (c) **high** and fragile, in-place by default · (d) **high**, and requires handling the value as tool input · (e) **high** — loses PR history and only helps if the old repo is deleted too · (f) **does not remove anything**. |
| **Recommended default** | **(b)**, executed **only** under the preconditioned runbook, because it is the only option that both removes the value from public history **and** leaves `stash@{0}`, `stash@{1}` and `G:\ProjectAI\_backups\` untouched (the rewrite happens in a separate mirror clone). |
| **Status** | `OPEN` — **not executed**; no mutating git command has been run. |
| **Hard constraints** | Stacked Draft PRs **#41–#45** (REPORTED) survive or their loss is accepted **in writing**; `stash@{0}`/`stash@{1}` and the `_backups` dir preserved (VERIFIED present). |
| **Facts it rests on** | 33 of 58 refs carry the value; `main` carries it from `3244553` (**2026-10-02**), i.e. **before** the recorded `83aaa53` — a rewrite keyed only on the recorded commit misses the default branch (VERIFIED). |
| **UNKNOWN that would change it** | whether GitHub keeps the blob reachable via `refs/pull/*` or caches after a rewrite; the true clone/fork population. |

---

## 4. D3 — whether to make the repository private

| Field | Content |
|---|---|
| **The decision** | Change repository visibility from public to private. |
| **Who owns it** | **Owner** (repo admin). |
| **What it unblocks** | Nothing on its own. It may **reduce ongoing bleed** while D2 is decided, at the cost of disrupting the public review flow. |
| **Options** | (a) stay public until D2 · (b) go private now as **containment**, then decide D2 · (c) go private and treat that as the answer. |
| **Risk of each** | (a) **exposure continues** for as long as D2 takes · (b) **low** if recorded as containment, but it disrupts the Draft PR workflow and does not retract anything already cloned · (c) **high** — it is **not remediation**; existing clones, forks, scrapes and caches keep the value, and a visibility change does not touch history. |
| **Recommended default** | Optional containment only; if taken, record explicitly that it **removes nothing** and D2 is still required. |
| **Status** | `OPEN — UNDECIDED`. |
| **Facts it rests on** | The repo is public and public reachability is VERIFIED; a private repo does not un-expose an already-cloned value (options §4). |

---

## 5. D4 — a pre-commit / CI secret-and-PII gate beyond the existing checks

| Field | Content |
|---|---|
| **The decision** | Add a second layer that blocks a leaked identifier **before it is committed** (a pre-commit hook), in addition to the existing CI guard (R4). |
| **Who owns it** | **Engineering** proposes; **owner** approves the change (it touches tooling/config). |
| **What it unblocks** | Durable prevention; reduces reliance on the single R4 CI guard. |
| **Options** | (a) keep the R4 CI guard only · (b) add a **pre-commit hook** running the same canonicalizing check · (c) a shared library both the hook and CI import, so the logic cannot drift · (d) a full third-party secret scanner. |
| **Risk of each** | (a) **low but single-layer** — a commit can still land and be caught only in CI · (b) **low** — cheap, blocks at the earliest point; needs a bypass path for false positives (e.g. a 13-digit epoch timestamp) · (c) **lowest drift risk**, one implementation · (d) **low but heavier**, another dependency and its own false positives/noise. |
| **Recommended default** | **(c)**, i.e. extract the R4 guard's canonicalizing check into one shared module, then call it from **both** a pre-commit hook and CI. The guard already proved its worth by catching its own author's doc comment. |
| **Status** | `OPEN` — the CI guard exists (VERIFIED: `backend/tests/nationalIdFixtureHygiene.test.js`); **no pre-commit hook is present** today. |
| **Note** | The R4 guard **canonicalizes before checking** precisely because a `\b\d{13}\b`-only matcher found 1 of 4 encodings; the shared gate must preserve that property. Also note `next-actions` rule 10: any such guard must **prove it is not vacuous** (assert files-read and match counts, and be mutation-tested). |

---

## 6. D5 — the data-protection basis for MJU Person API data generally (link G7)

| Field | Content |
|---|---|
| **The decision** | Whether RAE has a lawful basis / completed **DPIA + privacy-officer sign-off** for receiving `citizenID` from the MJU Person API **at all**, independent of this exposure. |
| **Who owns it** | **Owner + privacy officer** — this is contract gate **G7** (`docs/IDENTITY_MAPPING_CONTRACT.md` §6.1) and audit finding **F12** (`docs/IDENTITY_INTEGRATION_AUDIT.md` §0.2). *(This file does not edit `IDENTITY_MAPPING_CONTRACT.md` or `IDENTITY_INTEGRATION_AUDIT.md`; it links to them.)* |
| **What it unblocks** | The real identity-integration design gate (**ID-3**); whether any raw `citizenID` storage is ever lawful (**G4**); the ingestion path (**G5**). |
| **Options** | (a) begin and complete the **DPIA + sign-off** · (b) declare the MJU Person API out of scope and stop any dependency on it · (c) leave the gate closed and take no action. |
| **Risk of each** | (a) **medium effort, high value** — the governance policy found on this machine requires it before personal/sensitive-data access · (b) **low risk, but re-scopes the identity plan** (the audit already shows the API cannot populate the MJU identity kind, so this is a live option) · (c) **high** — the gate is documented as a requirement, not a formality, and integration cannot lawfully proceed without it. |
| **Recommended default** | **(a)** — start the DPIA path the governance policy already mandates. This is **independent** of the rewrite: a history rewrite removes the leak, it does not create a lawful basis. |
| **Status** | `OPEN` — **no evidence of a completed DPIA was found** (REPORTED: `IDENTITY_INTEGRATION_AUDIT.md` §0.2, F12; `DECISIONS.md` ID-3/ID-8). Identity integration remains at the design gate. |
| **Pointer** | `docs/IDENTITY_MAPPING_CONTRACT.md` §6.1 and §9; `docs/IDENTITY_INTEGRATION_AUDIT.md` §0.2 and F12; `docs/memory/DECISIONS.md` ID-3, ID-8. *(Read-only references — not modified.)* |

---

## 7. D6 — whether to close the incident

| Field | Content |
|---|---|
| **The decision** | Mark `PII-IN-FIXTURES-20261016` closed. |
| **Who owns it** | **Owner** (the incident record is owned by the orchestrator; this track does not edit it). |
| **What it unblocks** | Nothing operationally, but a premature close would misstate the exposure. |
| **Options** | (a) close after D1–D3 recorded and the runbook's V1–V10 hold · (b) close after D1/D5 only, with R3 accepted in writing · (c) never close (wrong — an incident with a recorded accepted risk is properly closed with a reason). |
| **Risk of each** | (a) **low** — the correct bar · (b) **medium** — only correct if the owner **explicitly writes down** acceptance of the residual public exposure (see D2 option (a)) · (c) **process rot** — an incident that can never close loses meaning. |
| **Recommended default** | **Keep `OPEN` today.** Close by **(a)**, or by **(b) with a written acceptance** if the owner chooses option (a) of D2. |
| **Status** | `BLOCKED` — on D1, D2, D3, D5. |

---

## 8. What is already decided (for context, not a decision row)

| Item | Status |
|---|---|
| R2 — redact committed literals, derive the one valid value at runtime | **DONE** (REPORTED; clean tree VERIFIED) |
| R4 — CI guard against checksum-valid literals, canonicalizing first | **DONE** (VERIFIED: file present) |
| R5 — repo-wide sweep | **DONE** (REPORTED) |
| The redaction is committed | **DONE** (`04ff9d0`, VERIFIED) — but only on **5 of 58 refs** |
| R1, R3 | **OPEN** — this document |

---

## 9. Owner sign-off block (to be completed by a human, not an agent)

| Row | Decision taken | Decided by | Date | Notes |
|---|---|---|---|---|
| D1 | ______________________ | ____________ | ________ | |
| D2 | ______________________ | ____________ | ________ | |
| D3 | ______________________ | ____________ | ________ | |
| D4 | ______________________ | ____________ | ________ | |
| D5 | ______________________ | ____________ | ________ | |
| D6 | ______________________ | ____________ | ________ | |

**Until this block is completed, every row is `OPEN` or `BLOCKED`, and the incident remains `OPEN` for R1 and R3.**
