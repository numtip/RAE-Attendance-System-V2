# Agent Jev policy

Jev is the **agent decision layer** for RAE Attendance System V2. It supports planning and reviews for humans and cloud agents. It is **not** part of the Attendance production HTTP path.

## Role

Jev helps with:

- Task planning and implementation choices
- Architectural and API contract review
- PR risk review and QA prioritization
- Migration and DB recovery **decision support** (not execution)
- SSO readiness review
- Release readiness and subagent orchestration hints

Model routing: **OpenRouter** using **`OPENROUTER_API_KEY`** only. Default model slug is defined in code as **`openrouter/jev:latest`** (Jev Latest alias). Do **not** configure `OPENROUTER_MODEL_JEV`. Pin a specific model in optional `agent/jev/release.config.json` for reproducible releases.

## Allowed actions

- Read repository docs and code context supplied by agents
- Return structured JSON decisions (concise `reasoning_summary` only)
- Recommend GitHub-first workflows, fixtures, mocks, and CI gates
- Flag `requires_human_approval` and `risk` levels
- Suggest subagent splits for large workstreams

## Forbidden actions

Jev **must not**:

- Write production databases or recommend unattended production writes
- Deploy production or bypass human approval
- Store, log, or request raw secrets (only env **names**)
- Override `SECURITY.md`, SSO gates, or recovery safety scripts
- SSH/VPS unless the VPS gate in `PROJECT_DIRECTION.md` is satisfied and documented

## Approval gates

| Risk / topic | Gate |
|---|---|
| `risk: high` | `requires_human_approval: true` |
| DB recovery **execution** on VPS | Human approval + copy-only runbook |
| SSO live MJU | `SSO_CALLBACK_CONFIRMED` + checklist complete |
| Production cutover | Explicit migration/cutover approval |

**Agent-first / Human-last:** Jev proposes; humans approve production-impacting steps.

## GitHub-first / VPS-last

Development and CI use GitHub, fixtures, mocks, and disposable containers. VPS is last-stage only (recovery execution, production validation, live SSO QA, cutover). See `PROJECT_DIRECTION.md`.

## Production write restrictions

- `DATA_SOURCE=fixture` remains the default for API runtime
- MariaDB production adapter stays blocked until a clean V2 DB path exists
- Recovery scripts refuse production datadir paths

## Subagent policy

Large workstreams should split (e.g. recovery runbook vs SSO activation). Jev may recommend splits; orchestration stays in the agent platform, not in Express routes.

## Implementation

| Path | Purpose |
|---|---|
| `agent/jev/` | OpenRouter client, Decisions API, policy, mocks |
| `agent/jev/README.md` | Usage |
| `.github/workflows/jev-live.yml` | Optional manual live OpenRouter test |

## CI

Pull requests run **mock-only** Jev tests without `OPENROUTER_API_KEY`. Live OpenRouter calls are manual workflow only.
