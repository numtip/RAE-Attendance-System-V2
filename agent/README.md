# Agent Core adapter (Attendance V2)

Attendance V2 consumes the shared **[Agent Core](https://github.com/numtip/agent-core)** API for bounded agent decisions. This folder is **agent-only** — not imported by the Express API runtime.

## Contract (Agent Core OpenAPI v0.2)

- `POST {AGENT_CORE_URL}/v1/decision`
- Headers: `x-agent-project`, optional `x-agent-project-token` (when auth is enabled on Agent Core)
- Request: `project`, `decision_type`, `state`, `question` (see `schemas/openapi.yaml` in agent-core)
- Response: `result`, `confidence`, `disposition`, `fallback`, …

## Environment (project repo)

```text
AGENT_CORE_URL=
AGENT_CORE_PROJECT=rae-attendance-v2
AGENT_CORE_PROJECT_TOKEN=
```

Do **not** put `OPENROUTER_API_KEY` in this repository — OpenRouter/Jev routing lives in Agent Core.

## Usage (agents / scripts)

```javascript
const {
  createMockAgentCoreProvider,
  createDecisionsApi,
  createDecisionsFromEnv,
} = require('./index');

const mock = createMockAgentCoreProvider();
const decisions = createDecisionsApi({ client: mock });

await decisions.decide({
  useCase: 'architecture_review',
  context: { summary: 'Release 1 schema' },
});
```

Live Agent Core (manual / approved automation only):

```javascript
const decisions = createDecisionsFromEnv();
// null when AGENT_CORE_URL is unset — CI uses mocks
```

## Using Jev live (verified 2026-10-16)

The adapter now reaches the real gateway. Two things it previously got wrong, both fixed:

1. a `choice` question was sent **without `criteria`**, which the gateway requires (≥ 2 entries) → HTTP 400;
2. the **Cloudflare Access** service-token headers were never sent, so the public edge refused the request
   with an HTML 403 before the origin saw it.

```powershell
. .\agent\scripts\use-live-credentials.ps1   # loads the DPAPI-stored credential into this shell only
node agent\cli.js doctor
node agent\scripts\live-smoke.mjs            # ONE live call; prints the decision, never the token
```

`use-live-credentials.ps1` reads `%LOCALAPPDATA%\agent-core\secrets.clixml` and sets process-scoped
environment variables. It never prints, writes or commits a secret.

**Scope, verified from the agent-core source:** this project holds `decision` only, so
`POST /v1/decision` is the ONLY callable endpoint. `TASK_ROUTE` is not achievable as an endpoint (it needs the
`route` scope) although it is a valid `decision_type` for the request body. See
`docs/AGENT_CORE_LIVE_USAGE.md` for the full scope table and the error-code guide.

Policy: `docs/AGENT_CORE_POLICY.md`
