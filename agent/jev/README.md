# Jev agent decision layer

Lightweight **agent-only** decision support for RAE Attendance V2. **Not** mounted on the Attendance HTTP API.

## Provider

- **OpenRouter** via `OPENROUTER_API_KEY` (only secret env var for Jev)
- Default model: **`openrouter/jev:latest`** (`JEV_OPENROUTER_MODEL_LATEST_ALIAS` in `constants.js`)
- Do **not** use `OPENROUTER_MODEL_JEV`
- Optional reproducible pin: copy `release.config.example.json` → `release.config.json` (gitignored) for release pipelines

## Usage (agents / scripts)

```javascript
const {
  createOpenRouterClient,
  createDecisionsApi,
  createMockOpenRouterProvider,
  createUseCaseHelpers,
} = require('./index');

const mock = createMockOpenRouterProvider();
const decisions = createDecisionsApi({ client: createOpenRouterClient({ provider: mock }) });
const helpers = createUseCaseHelpers(decisions);

await helpers.prRiskReview({ summary: 'Adds SSO adapter' });
```

Live OpenRouter (manual / approved automation only):

```javascript
const decisions = createJevDecisionsFromEnv();
```

Returns `null` when `OPENROUTER_API_KEY` is unset — CI uses mocks instead.

## Decision contract

```json
{
  "decision": "...",
  "reasoning_summary": "...",
  "risk": "low|medium|high",
  "recommended_action": "...",
  "requires_human_approval": false
}
```

Policy: `docs/AGENT_JEV_POLICY.md`
