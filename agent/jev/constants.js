/**
 * OpenRouter Jev Latest alias (default). Do not use OPENROUTER_MODEL_JEV env var.
 * For reproducible releases, pin `model` in agent/jev/release.config.json (optional).
 */
const JEV_OPENROUTER_MODEL_LATEST_ALIAS = 'openrouter/jev:latest';

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

module.exports = {
  JEV_OPENROUTER_MODEL_LATEST_ALIAS,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  RETRYABLE_STATUS,
};
