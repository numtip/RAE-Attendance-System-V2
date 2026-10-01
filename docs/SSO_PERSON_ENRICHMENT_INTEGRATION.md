# MJU Person Enrichment integration boundary for V2 SSO

**Status:** Approved design boundary; no runtime API integration and no SSO activation.
**Scope:** GitHub/CI and an operator's local workstation only. The legacy app, legacy database, V2 production data, and MJU live SSO contract remain untouched.

## Decision

MJU Person Enrichment is an **offline pre-provisioning and review tool**. It is not an SSO provider, a callback resolver, or an authorization source.

It may help an operator prepare and validate a proposed association between a known V2 employee and MJU contact data before the association is approved in V2. It must never:

- resolve the callback field `ac`;
- issue a V2 session, access token, refresh token, or role;
- call the Person API from browser, backend login/callback, CI, n8n, or a live request path;
- replace the MJU SSO identity proof or guess an unconfirmed SSO claim;
- write a national ID, Person API bearer token, cache, raw response, CSV, or audit extract into this repository or V2 database.

V2 remains fail-closed as defined in `SSO_CONTRACT_CONFIRMATION.md`: no session exists until the chain below is proven.

```
MJU callback contract -> validated MJU identity -> active V2 employee -> authorized scope
```

## What the local enrichment project contributes

The separate, local-only `mju-person-enrich` project already provides useful operator safeguards:

| Capability | Permitted V2 use |
|---|---|
| Thai-name normalization and controlled fallback search | Prepare a review candidate only |
| MJU Person API lookup with bearer token in local `.env` | Operator-only enrichment outside V2 |
| Retry, timeout, cache, rate limit, resume | Local batch reliability only |
| `found`, `not_found`, `ambiguous`, error status | Decide whether a human review is required |
| masked terminal output and Excel-safe export | Local review only |

The project is not an authoritative employee source. HR/onboarding evidence and an approved V2 employee record remain authoritative.

## Required safety corrections before its output is used

The current enrichment scripts are useful for local research but must be treated as **review-only** because they place data from the first response in output even when `match_count > 1`. An ambiguous result must contribute no identity value to V2.

The operator workflow must enforce all of the following:

1. Accept only an API response with exactly one record for automatic candidate preparation.
2. Treat `ambiguous`, `not_found`, `timeout`, `api_error`, and any fallback such as `firstname_only` as manual review only.
3. Do not auto-link by Thai name, email, employee code, or national ID.
4. Do not retain a national ID in V2. If an operator must use it to compare local evidence, the comparison happens locally and the ID is discarded from the V2 import.
5. Keep the Person API token, raw cache, raw responses, input/output files, and audit logs outside GitHub, CI artifacts, shared drives, and V2 runtime storage.
6. Require two-person approval (preparer and approver) before a proposed association is activated.

## Proposed approved-link record

When the MJU SSO administrator later confirms the identity claim, V2 should store only the minimum approved link, preferably in a dedicated table added through a reviewed migration:

| Field | Purpose |
|---|---|
| `employee_uid` | Existing V2 employee primary key |
| `provider` | Literal `mju-sso` |
| `provider_subject` | Confirmed immutable MJU SSO subject/claim; never guessed |
| `verified_email` | Normalized verified email, if MJU confirms it |
| `status` | `active`, `pending_review`, `disabled`, or `conflict` |
| `approved_by`, `approved_at` | Accountability for activation |
| `source_reference` | Non-sensitive internal evidence/reference ID |
| `created_at`, `updated_at` | Auditability |

Constraints:

- Unique `(provider, provider_subject)` and one active link per employee/provider.
- A conflict must deny login and require review.
- Roles, organization scope, FaceScan/HIP identifiers, and employee status remain separate authorization/domain records.
- No raw MJU Person API payload, national ID, or bearer token belongs in this table.

## Runtime behavior after the MJU contract is confirmed

1. Verify the callback according to the MJU-provided contract. Do not infer behavior from the current `ac` query field.
2. Obtain and validate the MJU identity claim using only the confirmed protocol.
3. Resolve an **active approved link** by provider subject. A verified email may be a secondary consistency check, not the sole authorization key.
4. Check employee status and authorization scope.
5. Issue the V2 session only after all four checks pass.
6. Deny unknown, pending, disabled, or conflicted links without revealing personal details.

Until MJU supplies a proven exchange/identity contract, `SSO_ENABLED=false` and `SSO_CALLBACK_DIAGNOSTIC=false` remain required.

## Implementation sequence

1. Fix the local enrichment tool so ambiguous results emit blank identity fields and a review item.
2. Define the operator-only review form/process and evidence retention period.
3. Obtain the MJU SSO callback, token/userinfo (or portal) contract and immutable identity claim in writing.
4. Add a V2 migration, repository methods, admin-only approval endpoint, and audit events using synthetic fixtures only.
5. Change SSO matching from email-only to the approved provider-subject link; retain fail-closed behavior.
6. Add tests for unknown, ambiguous/pending, conflict, inactive, replay, and approved active identities.
7. Perform one agreed non-production MJU test, then follow `SSO_ACTIVATION_RUNBOOK.md`.

## Explicit non-goals

- No SSO activation or live MJU request.
- No changes to `/attendance/` or the legacy client/database.
- No production import, national-ID migration, or FaceScan ID generation.
- No use of MJU Person API as a replacement for MJU SSO.

## Evidence to retain

Retain only the approval decision, non-sensitive reference, operator identities, timestamps, and status transitions in V2 audit logs. Keep underlying local enrichment files under the local privacy controls of the enrichment project and delete them according to the approved retention schedule.
