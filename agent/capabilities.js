const { DECISION_PATH } = require('./constants');
const { AgentCoreError } = require('./errors');

/**
 * Verified Agent Core boundary for this project.
 *
 * Evidence (read from numtip/agent-core source):
 *  - src/projects.ts declares { id: "rae-attendance-v2", defaultScopes: ["decision"] }.
 *  - The route guard is on the ROUTE, not the decision_type:
 *      POST /v1/decision            -> scope `decision`  <-- the ONLY project route
 *      GET  /v1/health              -> no auth
 *      everything else              -> scope route | qa | context | browser | metrics (403)
 *
 * Consequence encoded below: decision_type values such as NEXT_ACTION and QA_DISPOSITION
 * are usable, but /v1/route, /v1/qa and every /v2/* ENDPOINT are NOT available.
 * Adapter YAML feature flags (task_route, qa_disposition, ...) are declarative contracts,
 * NOT runtime permissions - a known, documented platform limitation.
 */

const VERIFIED_SCOPES = Object.freeze({
  PROJECT: 'rae-attendance-v2',
  SCOPES: Object.freeze(['decision']),
});

const SUPPORTED_PATHS = Object.freeze(['/v1/decision', '/v1/health']);

const UNAVAILABLE_ENDPOINTS = Object.freeze([
  Object.freeze({ path: '/v1/route', requiredScope: 'route' }),
  Object.freeze({ path: '/v1/subagent', requiredScope: 'route' }),
  Object.freeze({ path: '/v1/subagent/complete', requiredScope: 'route' }),
  Object.freeze({ path: '/v1/advanced-route', requiredScope: 'route' }),
  Object.freeze({ path: '/v2/capabilities', requiredScope: 'route' }),
  Object.freeze({ path: '/v2/capabilities/:id', requiredScope: 'route' }),
  Object.freeze({ path: '/v2/capabilities/search', requiredScope: 'route' }),
  Object.freeze({ path: '/v2/route', requiredScope: 'route' }),
  Object.freeze({ path: '/v2/execute', requiredScope: 'route' }),
  Object.freeze({ path: '/v2/rea/route', requiredScope: 'route' }),
  Object.freeze({ path: '/v1/qa', requiredScope: 'qa' }),
  Object.freeze({ path: '/v1/context', requiredScope: 'context' }),
  Object.freeze({ path: '/v2/context/govern', requiredScope: 'context' }),
  Object.freeze({ path: '/v2/knowledge/query', requiredScope: 'context' }),
  Object.freeze({ path: '/v2/browser/plan', requiredScope: 'browser' }),
  Object.freeze({ path: '/v2/browser/execute', requiredScope: 'browser' }),
  Object.freeze({ path: '/v1/projects', requiredScope: 'metrics' }),
  Object.freeze({ path: '/v1/metrics', requiredScope: 'metrics' }),
]);

/**
 * The decision_type values the gateway accepts, taken from agent-core `decisionTypeSchema` (8 values).
 *
 * HISTORY: this list previously contained `TASK_ROUTE_PROPOSAL`, which does NOT exist in the gateway enum.
 * Local validation therefore passed and the gateway answered 400. It is replaced by the real enum, verified
 * against the live service on 2026-10-16.
 *
 * NOTE, and the distinction matters: a `*_ROUTE` value here is a valid `decision_type` for the
 * `/v1/decision` BODY (the scope guard is per route, not per decision type), but this project still cannot
 * call the routing ENDPOINTS (`/v1/route`, `/v2/route`, ...), which require the `route` scope. See
 * UNAVAILABLE_ENDPOINTS.
 */
const SUPPORTED_DECISION_TYPES = Object.freeze([
  'TASK_ROUTE',
  'CONTEXT_ROUTE',
  'TOOL_ROUTE',
  'MODEL_ROUTE',
  'SUBAGENT_ROUTE',
  'NEXT_ACTION',
  'QA_DISPOSITION',
  'HUMAN_ESCALATION',
]);

function assertSupportedPath(path) {
  const normalized = String(path ?? '').trim();
  if (!SUPPORTED_PATHS.includes(normalized)) {
    throw new AgentCoreError(
      'AGENT_CORE_UNSUPPORTED_ENDPOINT',
      `Endpoint not available to project ${VERIFIED_SCOPES.PROJECT}: ${normalized || '(empty)'}`,
    );
  }
  return true;
}

function assertSupportedDecisionType(type) {
  const normalized = String(type ?? '').trim();
  if (!SUPPORTED_DECISION_TYPES.includes(normalized)) {
    throw new AgentCoreError(
      'AGENT_CORE_UNSUPPORTED_DECISION_TYPE',
      `Unsupported decision_type: ${normalized || '(empty)'}`,
    );
  }
  return true;
}

module.exports = {
  DECISION_PATH,
  SUPPORTED_DECISION_TYPES,
  SUPPORTED_PATHS,
  UNAVAILABLE_ENDPOINTS,
  VERIFIED_SCOPES,
  assertSupportedDecisionType,
  assertSupportedPath,
};
