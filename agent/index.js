const { createAgentCoreClient } = require('./agentCoreClient');
const { createAttendanceAgentCoreAdapter } = require('./adapter');
const {
  createDecisionsApi,
  createDecisionsFromEnv,
  createFallbackDecision,
  buildAgentCoreRequest,
} = require('./decisions');
const { DEFAULT_AGENT_CORE_PROJECT } = require('./constants');
const { createMockAgentCoreProvider } = require('./mockAgentCore');
const { USE_CASES, createUseCaseHelpers } = require('./useCases');
const { describeAgentCoreConfig, resolveAgentCoreConfig } = require('./config');
const {
  FORBIDDEN_PAYLOAD_KEYS,
  assertNoSensitiveContent,
  sanitizeContext,
} = require('./sanitize');
const {
  SUPPORTED_DECISION_TYPES,
  UNAVAILABLE_ENDPOINTS,
  VERIFIED_SCOPES,
  assertSupportedDecisionType,
  assertSupportedPath,
} = require('./capabilities');
const { main: runCliMain, runCli } = require('./cli');

module.exports = {
  DEFAULT_AGENT_CORE_PROJECT,
  FORBIDDEN_PAYLOAD_KEYS,
  SUPPORTED_DECISION_TYPES,
  UNAVAILABLE_ENDPOINTS,
  USE_CASES,
  VERIFIED_SCOPES,
  assertNoSensitiveContent,
  assertSupportedDecisionType,
  assertSupportedPath,
  buildAgentCoreRequest,
  createAgentCoreClient,
  createAttendanceAgentCoreAdapter,
  createDecisionsApi,
  createDecisionsFromEnv,
  createFallbackDecision,
  createMockAgentCoreProvider,
  createUseCaseHelpers,
  describeAgentCoreConfig,
  resolveAgentCoreConfig,
  runCli,
  runCliMain,
  sanitizeContext,
};
