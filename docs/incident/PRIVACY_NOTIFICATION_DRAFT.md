# Privacy notification draft — a Thai national ID exposed in a public repository

**Status:** `DRAFT — NOT SENT. NOT APPROVED.` · **Owner of the decision:** repository owner + privacy officer.
**Prepared:** 2026-10-16 (Asia/Bangkok) · **Supersedes:** the first draft in
`../SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md` §5.2 (improve, do not duplicate).

> **This file contains NO identifier value, in any encoding.** The recipient verifies the match themselves,
> from their own source. We never transmit the value.
>
> **This is not legal advice and is not a notice that has been given.** Sending any variant below is an owner
> decision (§"The ask"). If legal counsel redrafts this, their wording wins.

---

## 0. How to use this file

| Variant | Audience | Purpose | Send? |
|---|---|---|---|
| **A — Privacy officer / compliance** | The privacy officer and, through them, legal counsel | Ask for direction: history remediation, and whether to notify | **Owner decision** |
| **B — Affected individual (plain language)** | The person, **only if** the owner decides notification is required/recommended | Transparent disclosure in plain Thai/English | **Do NOT send without legal sign-off** |
| **C — Internal engineering record** (optional, no addressee) | The incident file | Keep the technical facts in one place | not a message |

Variant B must not be sent "just to be safe" without a decision: an unjustified notification is itself a
disclosure of the incident to the individual, and it is irreversible. **Notification is not assumed.**

---

## 1. Facts any variant relies on (single source of truth)

| Fact | Value | Label |
|---|---|---|
| Repository | `numtip/RAE-Attendance-System-V2` — **PUBLIC** | VERIFIED |
| What leaked | a **checksum-valid Thai citizen ID** used as a "synthetic" test fixture; byte-identical to a real `citizenID` from the MJU Person API | REPORTED |
| Where | 6 files in the working tree (5 tests + 1 doc); **1 file** on the default branch `main` | VERIFIED |
| Encodings | four (plain, hyphen-separated, Thai digits, full-width) | REPORTED |
| Public since | **2026-10-02** on the default branch (commit `3244553`); `2026-10-09` on the feature chain (`83aaa53`) | VERIFIED / REPORTED |
| Still exposed? | **YES** — the value is retrievable from `main`'s history today | VERIFIED |
| In RAE's onboarding scope? | **NO** | REPORTED |
| Other personal data exposed? | **NONE** (no name, address, e-mail, photo or attendance row) | REPORTED |
| Already fixed in the working tree? | **YES** — literals replaced, CI guard added | VERIFIED |
| Fixed in public history? | **NO** — requires a rewrite + force push, deliberately not run | VERIFIED |

---

## 2. Variant A — to the privacy officer (technical + compliance)

> **Subject:** PDPA review request — a Thai national ID was published in a public GitHub repository and remains in its history
>
> Dear **[PRIVACY OFFICER NAME — placeholder]**,
>
> **We are writing to ask for your direction, not to report a completed fix.** We have found, and partially
> remediated, an exposure of a real personal identifier in a **public** repository, and two decisions are
> outside the engineering team's authority.
>
> **What happened.** A Thai citizen ID was used as a *"synthetic"* national-ID sample in the automated tests of
> `numtip/RAE-Attendance-System-V2`, which is a **public** GitHub repository. It is checksum-valid and
> byte-identical to a `citizenID` value returned by the MJU Person API, so we assess it to be a real person's
> identifier rather than a coincidence (a coincidental match is roughly one in ten trillion). It was published
> on the default branch on **2026-10-02**.
>
> **What was involved.** Only the 13-digit number, in six files (five test files and one design document), in
> four encodings. The identifier ends in `5351`.
>
> **What was NOT involved.** No name, address, e-mail, photograph or attendance record was published with it.
> The individual is **not** one of the employees in our onboarding scope.
>
> **What we have already done (engineering).** Every committed literal has been replaced with a value that
> **fails** the Thai checksum (so it cannot be a real id); the one test that genuinely needs a valid checksum
> now derives it at run time; and a CI guard now fails the build if any checksum-valid 13-digit literal is ever
> committed again.
>
> **What remains exposed, and why we are writing.** The value is still retrievable from the repository's
> **public git history on the default branch**. Removing it requires rewriting history and force-pushing, which
> our governance forbids without explicit approval, and which would disrupt a stack of open Draft pull requests.
> We are also **not able to determine** whether anyone has already cloned, forked or archived the repository
> since 2026-10-02.
>
> **Our asks:**
> 1. **Direction on history rewriting** — do you want us to proceed with a rewrite + force push (see the
>    options register), or to accept and document the exposure?
> 2. **Direction on notifying the affected individual** — is notification required, recommended or not
>    indicated, and on what basis?
> 3. **The data-protection basis for MJU Person API data generally** — this incident sits on top of an
>    existing open item (contract **G7**): a completed **DPIA + privacy-officer sign-off** for receiving
>    `citizenID` at all. We have found no evidence such a DPIA is complete.
> 4. Any **internal-reporting or regulator-notification** obligations, and their timelines, as you assess them.
>
> **How you can verify the match yourself, without us sending you the value.**
> The identifier in question **ends in `5351`**. You can confirm the match by comparing, **inside your own
> controlled environment**, (a) the id present in `backend/tests/employeeIdentity.test.js` on the repository's
> default branch with (b) the corresponding record in the MJU source. We are deliberately not transmitting the
> full value, not even in a masked-plus-encoding form, so that this document cannot itself become a copy of it.
>
> **Please reply to:** **[OWNER NAME — placeholder]**, **[OWNER CONTACT — placeholder]**.
> **Engineering contact:** **[ENGINEERING OWNER — placeholder]**. **Incident reference:** `PII-IN-FIXTURES-20261016`.
>
> This message is a request for direction and is **not legal advice**.

---

## 3. Variant B — to the affected individual (plain language)

> **Do NOT send without legal sign-off** (see §0). Written to be plain; a Thai translation should be prepared
> and reviewed before sending. Replace every **[square-bracket]** placeholder.
>
> ---
>
> **Subject:** Important notice about your personal information
>
> Dear **[NAME]**,
>
> We are writing to tell you about a mistake we made with your personal information, and what we are doing
> about it. We are sorry this happened.
>
> **What happened.** Your national identification number was used, by mistake, as a fake sample in the
> automated tests of a software project we publish openly on the internet. It was there from **2 October
> 2026** until we replaced it on **16 October 2026**. Because the project is public, someone could have seen
> or copied the number while it was there.
>
> **What information was involved.** Only your national identification number. The number was the whole of it.
>
> **What information was NOT involved.** Nothing else about you was published. No name, no address, no contact
> details, no photograph, and no attendance or work records.
>
> **What we have already done.** We have removed the number from every file we publish, and we have added a
> safety check that stops the same mistake from happening again. We have also begun a review of how this
> information came to be stored in our systems in the first place.
>
> **What we cannot yet say.** The number may still be recoverable from older copies of the project online. We
> are reviewing whether we can remove those too, and that decision is being taken now with our privacy adviser.
> We cannot know whether anyone actually looked at it.
>
> **What you can do.** **[Insert the specific, verified guidance once the data-protection review decides it —
> for example, monitoring for identity misuse, or a contact at the relevant authority. Do not invent advice
> here.]**
>
> **Who to contact.** **[PRIVACY CONTACT NAME — placeholder]**, **[CONTACT — placeholder]**.
>
> We will tell you the outcome of our review by **[DATE — placeholder]**.
>
> Yours sincerely,
> **[OWNER NAME — placeholder]**
>
> ---

---

## 4. Variant C — internal engineering record (not a message)

Keep the technical facts in `docs/incident/PRIVACY_INCIDENT_REVIEW_20261016.md` and the options in
`docs/incident/HISTORY_REMEDIATION_OPTIONS.md`. Do not duplicate the masked value into a third place beyond
`****5351`.

---

## 5. The ask (restated — this is the decision being requested)

| # | Decision requested | From | Default if unanswered |
|---|---|---|---|
| 1 | Direction on **history rewriting** (R3) | owner + privacy officer | do nothing, keep documenting the exposure |
| 2 | Direction on **notifying the individual** (R1) | owner + privacy officer / legal | do not notify (notification is not assumed) |
| 3 | The **data-protection basis** for MJU Person API data (contract **G7**) | owner + privacy officer | integration stays at the design gate |
| 4 | Any **regulator/internal reporting** obligation and its deadline | privacy officer / legal | none assumed; revisit at each review |

**This draft has not been sent. It contains no value. It closes nothing; the incident remains `OPEN` for R1
and R3.**
