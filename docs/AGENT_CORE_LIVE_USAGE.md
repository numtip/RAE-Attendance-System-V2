# Agent Core (Jev) — live usage

**Status: WORKING.** Verified end to end against the live gateway on **2026-10-16**: the repo's own adapter
received real decisions from Jev with `provider_request_id` values.

Companion documents: [`unified/07_SLICE2_ATTENDANCE_ENGINE.md`](unified/07_SLICE2_ATTENDANCE_ENGINE.md) §1.2
and §3 (the boundary), `agent/README.md` (the adapter), `agent/capabilities.js` (what is callable).

---

## 1. What "using Jev" means here

Agent Core is the control plane; **Jev is the decision model behind it**. This repo does not host Jev and
must not: the gateway and model run on the platform (`https://agent.raemanagemju.net`, origin on the VPS).
This repo holds an **adapter** that calls one endpoint.

```
repo (agent/)  ──POST /v1/decision──►  Cloudflare edge  ──►  Agent Core gateway  ──►  Jev model
```

Two things therefore have to be true before a call succeeds, and **both were broken** until this change:

| Requirement | Was | Now |
|---|---|---|
| A gateway-valid request body | a `choice` question was sent **without `criteria`**; the gateway requires ≥ 2 entries → **HTTP 400 every time** | `buildQuestion()` supplies default criteria per decision type and validates locally |
| The Cloudflare Access service-token headers | never sent → the **edge refused with an HTML 403** before the origin saw it | `agentCoreClient` sends `CF-Access-Client-Id`/`CF-Access-Client-Secret` when configured |

A third defect: `SUPPORTED_DECISION_TYPES` listed `TASK_ROUTE_PROPOSAL`, which **does not exist** in the
gateway enum, so local validation passed and the gateway answered 400. It now mirrors the real 8-value enum.

## 2. Scope: what this project may call

**`decision` only.** Verified from the agent-core source (`src/projects.ts`, `docs/STATUS.md`) and confirmed
by the live smoke:

| Endpoint | Scope | Available |
|---|---|---|
| `POST /v1/decision` | `decision` | **yes — the only one** |
| `GET /v1/health` | none | yes |
| `POST /v1/route`, `/v1/subagent`, `/v1/advanced-route` | `route` | no (403) |
| `GET/POST /v2/capabilities*`, `/v2/route`, `/v2/execute`, `/v2/rea/route` | `route` | no (403) |
| `POST /v1/qa` | `qa` | no (403) |
| `POST /v1/context`, `/v2/context/govern`, `/v2/knowledge/query` | `context` | no (403) |
| `/v2/browser/*` | `browser` | no (403) |

**`TASK_ROUTE` is therefore NOT achievable as an endpoint.** It IS a valid `decision_type` for the
`/v1/decision` **body** (the guard is per route, not per decision type), so this project can ask the model to
advise on routing; it just cannot call the routing endpoints. `.ai/jev.yaml` claims `task_route: true` and
`gateway_execute: true` — those are **declarative contracts, not permissions**.

## 3. Credentials — never in this repo

The credential lives in a **per-user DPAPI store** managed by the agent-core custody tooling:

```
%LOCALAPPDATA%\agent-core\secrets.clixml     (project token + Cloudflare Access service token)
```

Nothing is committed. `AGENT_CORE_CUSTODY_DIR` may override where `bin/AgentCore.psm1` is found.

Environment variables the adapter reads (either naming scheme works; `AGENT_CORE_*` wins):

| Variable | Purpose |
|---|---|
| `AGENT_CORE_URL` or `AGENT_PLATFORM_URL` | gateway base URL |
| `AGENT_CORE_PROJECT` or `AGENT_PROJECT` | project id (default `rae-attendance-v2`) |
| `AGENT_CORE_PROJECT_TOKEN` or `AGENT_PROJECT_TOKEN` | project token |
| `AGENT_CORE_CF_CLIENT_ID` | Cloudflare Access service-token id |
| `AGENT_CORE_CF_CLIENT_SECRET` | Cloudflare Access service-token secret |

## 4. How to run it

```powershell
cd G:\ProjectAI\rae-attendance-system-v2

# 1. Load the stored credential into THIS shell only (never prints the secret; sets nothing else)
. .\agent\scripts\use-live-credentials.ps1

# 2. Confirm what the adapter sees (token shown as a boolean, hostname only)
node agent\cli.js doctor

# 3. One live decision (this is the only script that contacts the real gateway, and it makes ONE call)
node agent\scripts\live-smoke.mjs --use-case migration_planning

# 4. Or use the CLI directly
node agent\cli.js decide --use-case pr_risk_review --summary "synthetic summary"
```

Without credentials every entry point **fails closed** with a message naming what is missing; `live-smoke`
also has `--dry-run` to check the configuration without calling.

### Observed results (2026-10-16, real calls)

```
POST /v1/decision   QA_DISPOSITION   -> disposition EXECUTE, confidence 0.90, fallback false
POST /v1/decision   NEXT_ACTION      -> disposition FALLBACK, confidence 0.22, fallback true
```

Both returned a real `provider_request_id` (for example `gen-dec-1792125358-...`). The second is **not a
failure**: the smoke sends deliberately thin synthetic context, so the model correctly returned low
confidence and `defer_to_human`. That is the designed fail-safe, and the adapter maps it to
`requires_human_approval: true`.

## 5. Safety properties (unchanged, and enforced)

* **No PII leaves the process.** `decide()` calls `sanitizeContext` then `assertNoSensitiveContent` on every
  request, so names, national IDs, employee/facescan identifiers, attendance rows, tokens and raw logs are
  redacted or refused before the request is built.
* **A decision never authorises a privileged action.** `agent/policy.js` blocks forbidden intents and forces
  `requires_human_approval` for `REVIEW`/`FALLBACK`/high risk.
* **Agent Core is never on the attendance request path.** The Express runtime does not import `agent/` at all,
  and a test injects a failing advisory and proves the stored calculation is unchanged. An Agent Core outage
  cannot block or alter an attendance calculation.
* **Nothing is retried blindly.** A malformed body, a gateway rejection or an edge refusal surfaces its own
  error code instead of being collapsed into a generic "unavailable"; only timeouts, network faults and 5xx
  are retried.

## 6. When it breaks, what the error means

| Code | Meaning | Action |
|---|---|---|
| `AGENT_CORE_EDGE_FORBIDDEN` | the edge refused before the gateway saw it | the Cloudflare Access pair is missing/invalid |
| `AGENT_CORE_PROVIDER_ERROR` (401) | the project token was rejected | it may have been rotated; the platform must redo the handoff |
| `AGENT_CORE_PROVIDER_ERROR` (403) | the gateway refused this project for this route | check the scope table in §2 |
| `AGENT_CORE_INVALID_QUESTION` | the request would have been a 400 | local validation caught it; fix the question shape |
| `AGENT_CORE_TIMEOUT` / `AGENT_CORE_UNAVAILABLE` | network or 5xx, retried | safe to retry |
| `AGENT_CORE_MALFORMED_RESPONSE` | non-JSON body that was not a 403 | the gateway or an intermediary misbehaved |

## 7. Not done / deliberately out of scope

1. **Nothing calls Jev automatically.** The adapter and both scripts are the only call sites, and they are
   manual. Wiring a decision into a workflow is a separate decision — see `docs/memory/NEXT_ACTIONS.md`.
2. **`requires_human_approval` is advisory.** The platform's rule is that a decision is never a release
   approval.
3. **No `route`/`qa`/`context` scope.** Requesting it from the platform owner is an owner action.
4. **The Cloudflare Access pair is a machine secret.** It is read from the DPAPI store; treat rotation as a
   platform operation.
