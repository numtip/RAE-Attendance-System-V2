/**
 * ESLint flat config for the Agent Core adapter folder.
 *
 * Why this file exists: `agent/` is a separate package (its own package.json) and previously had no ESLint
 * config, so nothing linted it. Unlike `backend/`, this folder is NOT on the request path, but it holds the
 * payload-sanitization boundary that decides what may be sent to Agent Core, so it deserves static checks.
 *
 * Running it (ESLint is NOT installed in this folder; it has no dependencies and no lockfile):
 *   ../backend/node_modules/.bin/eslint .        # reuse the backend install (ESLint 9.x, flat config)
 *
 * KNOWN GAP: the `agent-core` CI job runs `npm test` only, so this config is not yet enforced in CI.
 * Enforcing it needs an eslint devDependency plus a lockfile for this package, which is a build-system
 * change worth tracking separately rather than smuggling into a feature slice. See
 * docs/unified/07_SLICE2_ATTENDANCE_ENGINE.md section 6.
 *
 * The rules below are the relevant subset of ESLint's recommended set, declared inline rather than by
 * spreading `@eslint/js`: that package is installed only under `backend/node_modules`, and Node cannot
 * resolve it from this folder. Keeping the config dependency-free means it works wherever eslint lives.
 */
module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      // Same convention as backend/: CommonJS sourceType provides require/module/exports/__dirname.
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      // Mirrors backend/eslint.config.js so the two folders cannot drift apart.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Correctness rules from the recommended set, restricted to those that can hide a real bug.
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-constant-condition': 'error',
      'no-cond-assign': 'error',
      'no-control-regex': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-ex-assign': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-async-promise-executor': 'error',
      // `require-atomic-updates` is deliberately NOT enabled here. In this folder it produces only false
      // positives on two intentional patterns: `process.exitCode = code` at the end of an async CLI main()
      // (agent/cli.js) and restoring `process.env.X` inside a test's `finally` (tests/decisions.test.js).
      // Both are correct as written; the rule's noisy global-assignment heuristic is not worth the noise in
      // a folder whose real risk is what it SENDS, not how it sets process state.
      'valid-typeof': 'error',
      'use-isnan': 'error',
      // Surfaces a leaked debug statement in a module that must never log secrets.
      'no-debugger': 'error',
    },
  },
];
