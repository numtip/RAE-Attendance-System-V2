const { resolveAgentCoreConfig, describeAgentCoreConfig } = require('./config');
const { sanitizeContext, assertNoSensitiveContent } = require('./sanitize');
const {
  SUPPORTED_DECISION_TYPES,
  UNAVAILABLE_ENDPOINTS,
  VERIFIED_SCOPES,
  assertSupportedPath,
} = require('./capabilities');
const { createDecisionsFromEnv, createFallbackDecision } = require('./decisions');

/**
 * Small opt-in local CLI adapter (Phase C item 3) for sanitized development metadata.
 * Dependency-free (no yargs/commander), CommonJS, network only for `decide`.
 * The project token is never printed.
 */

const USAGE = [
  'usage: node cli.js <command>',
  '  doctor',
  '  decide --use-case <name> [--summary <text>] [--context <json>]',
  '  probe --path <path>',
].join('\n');

function render(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function parseFlags(tokens) {
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = tokens[index + 1];
    if (next != null && !next.startsWith('--')) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

async function runCli(argv = process.argv.slice(2), options = {}) {
  const env = options.env || process.env;
  const write = options.write || ((chunk) => process.stdout.write(chunk));
  const writeError = options.writeError || ((chunk) => process.stderr.write(chunk));
  const command = String(argv[0] || '');
  const flags = parseFlags(argv.slice(1));

  if (command === 'doctor') {
    write(render({
      config: describeAgentCoreConfig(resolveAgentCoreConfig(env)),
      verifiedScopes: VERIFIED_SCOPES,
      supportedDecisionTypes: SUPPORTED_DECISION_TYPES,
      unavailableEndpoints: UNAVAILABLE_ENDPOINTS,
    }));
    return 0;
  }

  if (command === 'decide') {
    const useCase = flags['use-case'];
    if (typeof useCase !== 'string' || useCase.trim() === '') {
      writeError(`${render({ error: 'missing --use-case' })}${USAGE}\n`);
      return 2;
    }

    let context = {};
    if (flags.context != null) {
      try {
        context = JSON.parse(flags.context);
      } catch {
        writeError(`${render({ error: 'invalid --context json' })}${USAGE}\n`);
        return 2;
      }
    }
    if (typeof flags.summary === 'string' && context.summary == null) {
      context = { ...context, summary: flags.summary };
    }

    try {
      const sanitized = sanitizeContext(context);
      assertNoSensitiveContent(sanitized.value);

      const decisionsApi = createDecisionsFromEnv({ env, fetchImpl: options.fetchImpl });
      if (!decisionsApi) {
        write(render(createFallbackDecision('Agent Core not configured')));
        return 0;
      }

      const result = await decisionsApi.decide({ useCase, context: sanitized.value });
      write(render(result));
      return 0;
    } catch (err) {
      writeError(render({ error: { code: err?.code || 'AGENT_CORE_CLI_ERROR', message: err?.message || 'unknown' } }));
      return 1;
    }
  }

  if (command === 'probe') {
    const path = flags.path;
    if (typeof path !== 'string' || path.trim() === '') {
      writeError(`${render({ error: 'missing --path' })}${USAGE}\n`);
      return 2;
    }
    try {
      assertSupportedPath(path);
      write(render({ supported: true, path }));
    } catch (err) {
      write(render({ supported: false, path, code: err?.code || 'AGENT_CORE_UNSUPPORTED_ENDPOINT' }));
    }
    return 0;
  }

  writeError(`${render({ error: `unknown command: ${command || '(none)'}` })}${USAGE}\n`);
  return 2;
}

async function main(argv = process.argv.slice(2), options = {}) {
  const code = await runCli(argv, options);
  if (options.setExitCode !== false) {
    process.exitCode = code;
  }
  return code;
}

if (require.main === module) {
  main();
}

module.exports = { main, runCli };
