const { DEFAULT_AGENT_CORE_PROJECT } = require('./constants');

/**
 * Agent Core configuration resolution.
 *
 * Naming rationale: AGENTS.md names the shared control-plane variables
 * AGENT_PLATFORM_URL / AGENT_PROJECT / AGENT_PROJECT_TOKEN, while this adapter
 * historically used AGENT_CORE_URL / AGENT_CORE_PROJECT / AGENT_CORE_PROJECT_TOKEN.
 * Both schemes must work and the legacy AGENT_CORE_* names WIN, so existing
 * deployments keep their current behaviour.
 *
 * The project token is returned for callers that still need to send it, but it is
 * NEVER logged: `describeAgentCoreConfig` exposes only a boolean `tokenPresent`.
 */

function isNonBlank(value) {
  return value != null && String(value).trim() !== '';
}

function firstNonBlank(candidates) {
  for (const candidate of candidates) {
    if (isNonBlank(candidate)) {
      return String(candidate).trim();
    }
  }
  return '';
}

function resolveAgentCoreConfig(env = process.env, options = {}) {
  const safeEnv = env || {};
  const safeOptions = options || {};

  let baseUrl = '';
  let source = 'none';
  if (isNonBlank(safeOptions.baseUrl)) {
    baseUrl = String(safeOptions.baseUrl).trim();
    source = 'options';
  } else if (isNonBlank(safeEnv.AGENT_CORE_URL)) {
    baseUrl = String(safeEnv.AGENT_CORE_URL).trim();
    source = 'AGENT_CORE_*';
  } else if (isNonBlank(safeEnv.AGENT_PLATFORM_URL)) {
    baseUrl = String(safeEnv.AGENT_PLATFORM_URL).trim();
    source = 'AGENT_PLATFORM_*';
  }

  let projectId = '';
  let projectIdSource = 'default';
  if (isNonBlank(safeOptions.projectId)) {
    projectId = String(safeOptions.projectId).trim();
    projectIdSource = 'options';
  } else if (isNonBlank(safeEnv.AGENT_CORE_PROJECT)) {
    projectId = String(safeEnv.AGENT_CORE_PROJECT).trim();
    projectIdSource = 'AGENT_CORE_*';
  } else if (isNonBlank(safeEnv.AGENT_PROJECT)) {
    projectId = String(safeEnv.AGENT_PROJECT).trim();
    projectIdSource = 'AGENT_PLATFORM_*';
  } else {
    projectId = DEFAULT_AGENT_CORE_PROJECT;
    projectIdSource = 'default';
  }

  const projectToken = firstNonBlank([
    safeOptions.projectToken,
    safeEnv.AGENT_CORE_PROJECT_TOKEN,
    safeEnv.AGENT_PROJECT_TOKEN,
  ]);

  return {
    baseUrl,
    projectId,
    projectToken,
    configured: isNonBlank(baseUrl),
    source,
    projectIdSource,
    tokenPresent: isNonBlank(projectToken),
  };
}

/**
 * Safe diagnostic projection: hostname only (credentials, path and query stripped),
 * and a boolean instead of the token. Never add the token or full URL here.
 */
function describeAgentCoreConfig(config = {}) {
  const raw = isNonBlank(config.baseUrl) ? String(config.baseUrl).trim() : '';
  let baseUrlHost = '<unparseable>';
  let baseUrlIsHttps = false;
  if (raw) {
    try {
      const parsed = new URL(raw);
      baseUrlHost = parsed.hostname || '<unparseable>';
      baseUrlIsHttps = parsed.protocol === 'https:';
    } catch {
      baseUrlHost = '<unparseable>';
      baseUrlIsHttps = false;
    }
  }

  return {
    baseUrlHost,
    baseUrlIsHttps,
    projectId: config.projectId || '',
    tokenPresent: Boolean(config.tokenPresent ?? config.projectToken),
    source: config.source || 'none',
  };
}

module.exports = {
  describeAgentCoreConfig,
  resolveAgentCoreConfig,
};
