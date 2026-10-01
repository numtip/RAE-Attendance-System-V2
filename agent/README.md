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

Policy: `docs/AGENT_CORE_POLICY.md`
