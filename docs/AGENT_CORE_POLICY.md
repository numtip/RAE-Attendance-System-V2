# Agent Core policy

Attendance V2 consumes the shared **[Agent Core](https://github.com/numtip/agent-core)** service for bounded agent decisions. It **does not** own a separate Jev/OpenRouter runtime.

## Scope

Agent Core / Jev (via Agent Core) helps with:

- architecture decisions
- migration planning
- security / risk review
- PR risk
- SSO readiness
- release readiness
- complex subagent routing recommendations

Routine implementation (CRUD, fixtures, CI fixes) should **not** call Agent Core.

## Transport

- API: `POST /v1/decision` on `AGENT_CORE_URL`
- Project identity: `AGENT_CORE_PROJECT=rae-attendance-v2` (header `x-agent-project` must match body `project`)
- Optional auth: `AGENT_CORE_PROJECT_TOKEN` → header `x-agent-project-token` when Agent Core auth is enabled

OpenRouter keys and Jev model routing live **only** in Agent Core — never in this repository.

## Hard rules

Agent-assisted flows **must not**:

- write production databases
- deploy production
- bypass human approval
- store or log secrets
- SSH to VPS without documented VPS gate

**Agent-first / Human-last:** Agent Core proposes; humans approve production-impacting steps.

## When Agent Core is unavailable

- Routine GitHub-first work continues with deterministic defaults
- Fallback decisions require human approval
- No automatic approval of risky actions

## Repository layout

| Path | Role |
|---|---|
| `agent/agentCoreClient.js` | HTTP client for Agent Core `/v1/decision` |
| `agent/decisions.js` | Project decision API + fallback |
| `agent/adapter.js` | Attendance-specific adapter |
| `agent/mockAgentCore.js` | CI-safe mock provider |
| `agent/tests/` | Adapter tests (no live Agent Core) |

CI runs mock-only tests. Live Agent Core calls are manual and optional outside default PR gates.
