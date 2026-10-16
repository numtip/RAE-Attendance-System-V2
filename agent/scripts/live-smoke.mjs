#!/usr/bin/env node
/**
 * Opt-in LIVE smoke for the Agent Core decision path.
 *
 * This is the only script in the repo that contacts the real gateway, and it is deliberately manual:
 *   * it refuses to run without credentials (fail closed, and says exactly what is missing);
 *   * it makes exactly ONE decision call, so the cost is bounded and visible;
 *   * it prints the decision and a redacted config summary, and NEVER the token or the Access secret.
 *
 * Usage (PowerShell, from the repo root):
 *   . .\agent\scripts\use-live-credentials.ps1      # loads the DPAPI-stored credential into this shell
 *   node agent\scripts\live-smoke.mjs
 *   node agent\scripts\live-smoke.mjs --use-case migration_planning
 *
 * Exit codes: 0 = a decision came back; 1 = something failed (with the reason printed); 2 = usage.
 *
 * Scope reminder, verified from the agent-core source: the project holds `decision` only, so
 * POST /v1/decision is the ONLY endpoint this project may call. Routing/QA/context/browser endpoints answer
 * 403 and are listed in agent/capabilities.js.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolveAgentCoreConfig, describeAgentCoreConfig } = require(join(here, '..', 'config.js'));
const { createDecisionsFromEnv } = require(join(here, '..', 'decisions.js'));
const { USE_CASES } = require(join(here, '..', 'useCases.js'));

function parseArgs(argv) {
  const args = { useCase: USE_CASES.PR_RISK_REVIEW, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--use-case') {
      args.useCase = argv[index + 1];
      index += 1;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else {
      args.unknown = token;
    }
  }
  return args;
}

function fail(message, code = 1) {
  console.error(`live-smoke: ${message}`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log('usage: node agent/scripts/live-smoke.mjs [--use-case <name>] [--dry-run]');
  console.log(`use cases: ${Object.values(USE_CASES).join(', ')}`);
  process.exit(0);
}
if (args.unknown) fail(`unknown argument: ${args.unknown}`, 2);
if (!Object.values(USE_CASES).includes(args.useCase)) {
  fail(`unknown use case '${args.useCase}'. Known: ${Object.values(USE_CASES).join(', ')}`, 2);
}

const config = resolveAgentCoreConfig(process.env);
console.log('config:', JSON.stringify(describeAgentCoreConfig(config)));

if (!config.configured) {
  fail('no gateway URL. Set AGENT_CORE_URL (or AGENT_PLATFORM_URL), or load the stored credential with'
    + ' `. .\\agent\\scripts\\use-live-credentials.ps1`');
}
if (!config.tokenPresent) {
  fail('no project token. Set AGENT_CORE_PROJECT_TOKEN (or AGENT_PROJECT_TOKEN), or use the credential loader.');
}
if (!config.cfAccessPresent) {
  // Not fatal in principle: an origin without Cloudflare Access in front would accept the request. Warn,
  // because against the public edge a missing Access pair produces an HTML 403 that looks like a mystery.
  console.warn('live-smoke: no Cloudflare Access service token configured; the public edge may refuse the call'
    + ' (AGENT_CORE_CF_CLIENT_ID / AGENT_CORE_CF_CLIENT_SECRET).');
}

const decisions = createDecisionsFromEnv();
if (!decisions) fail('the adapter reported itself unconfigured despite a usable config');

if (args.dryRun) {
  console.log('dry-run: configuration looks usable; no call was made.');
  process.exit(0);
}

console.log(`calling POST /v1/decision once (use case: ${args.useCase}) ...`);

try {
  const result = await decisions.decide({
    useCase: args.useCase,
    context: {
      // Synthetic, bounded, and free of names, identifiers, tokens and attendance rows.
      summary: 'live smoke: synthetic metadata only; no employee data, identifiers or credentials',
      changedFiles: 0,
    },
  });
  console.log('RESULT: OK');
  console.log(JSON.stringify({
    decision_type: result.decision_type,
    decision: result.decision,
    disposition: result.disposition,
    confidence: result.confidence,
    fallback: result.fallback,
    requires_human_approval: result.requires_human_approval,
    provider_request_id: result.provider_request_id,
  }, null, 2));
  // Set the code and let Node finish draining its handles. Calling process.exit() here races the
  // still-closing fetch socket and crashes libuv on Windows
  // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c").
  process.exitCode = 0;
} catch (error) {
  console.error('RESULT: FAILED');
  console.error(`  code   : ${error.code}`);
  if (error.status != null) console.error(`  status : ${error.status}`);
  console.error(`  message: ${error.message}`);
  if (error.code === 'AGENT_CORE_EDGE_FORBIDDEN') {
    console.error('  hint   : the Cloudflare Access service token is missing or invalid; the request never'
      + ' reached the gateway.');
  }
  if (error.code === 'AGENT_CORE_PROVIDER_ERROR' && error.status === 401) {
    console.error('  hint   : the project token was rejected. It may have been rotated; re-run the'
      + ' platform-side handoff for rae-attendance-v2.');
  }
  process.exitCode = 1;
}
