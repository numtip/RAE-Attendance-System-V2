/**
 * Identity-link source policy (hardening ID-7).
 *
 * The allowlist is only useful if it stays complete. The failure mode this guards against is subtle and
 * future-facing: someone adds a new code path that writes a NEW `source` string, and because
 * `enrichmentBlocksApproval` is scoped to KNOWN enrichment sources, that new source silently escapes the
 * ambiguity guard. The fix is not more runtime checking - it is a test that FAILS when a source literal
 * appears in an identity-link code path without being added to the allowlist.
 *
 * It also asserts the reverse direction, so the allowlist cannot quietly rot into a list of entries nobody
 * uses: an unused entry must be declared as unused, with a reason.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  IDENTITY_LINK_SOURCES,
  ENRICHMENT_SOURCES,
  BLOCKED_ENRICHMENT_OUTCOMES,
  BLOCKED_ENRICHMENT_CONFIDENCES,
  isKnownSource,
  isEnrichmentSource,
} = require('../src/domain/identityLink');

const SRC_ROOT = path.join(path.dirname(require.resolve('../src/domain/identityLink')), '..');

/** Files that create an identity link, found by the calls that only exist for that purpose. */
const LINK_CREATION_MARKERS = ['insertLink(', 'createCandidate(', 'linkProviderSubjectFromSsoLogin('];

/**
 * Allowlist entries that no `source:` literal uses yet, with the reason. An entry here is a DECLARED
 * intent, not dead code - and it must be justified, so the list cannot absorb accidental leftovers.
 */
const UNUSED_BY_DESIGN = new Map([
  // The Person API path is designed (see docs/IDENTITY_MAPPING_CONTRACT.md §3) but deliberately NOT built
  // yet: the design gate is open. The source is allowlisted so that, when it is built, its provenance is
  // already a known value rather than a new string nobody validated.
  ['person_api_enrich', 'reserved for the not-yet-built Person API ingestion path (design gate open)'],
]);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

/**
 * Source strings used in a file that creates identity links.
 *
 * A source can reach a link in three syntactic forms, and an earlier version of this test only caught the
 * first - which made it VACUOUS, because no link-creating file currently uses that form. The non-vacuity
 * test below now fails if this extraction returns nothing, which is how the gap was found.
 *
 *   1. `source: 'literal'`                - plain assignment
 *   2. `source: cond ? 'literal' : x`     - ternary (the MJU token-flow source)
 *   3. `source = 'literal'`               - default parameter / variable
 */
function collectSourceLiterals() {
  const literals = new Map(); // source -> Set<file>
  let scannedFiles = 0;
  let creationFiles = 0;
  let sourceLines = 0;

  for (const file of walk(SRC_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    scannedFiles += 1;
    const createsLinks = LINK_CREATION_MARKERS.some((marker) => text.includes(marker));
    if (!createsLinks) continue;
    creationFiles += 1;

    const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
    for (const line of text.split('\n')) {
      // Only lines that assign/declare a `source`, so unrelated snake_case strings are not swept in.
      if (!/\bsource\b\s*[:=]/.test(line)) continue;
      // Skip COMPARISONS. `input.source === 'mju_token'` names the inbound SSO flow, not a link source; it
      // is a different concept that happens to share the word. Without this, the guard reports a false
      // positive that would tempt someone to widen the allowlist with a value that is not a link source.
      if (/\bsource\b\s*[!=]==/.test(line)) continue;
      sourceLines += 1;
      // Identifier-shaped literals only: a source name is a snake_case token.
      for (const match of line.matchAll(/'([A-Za-z][A-Za-z0-9_]*)'|"([A-Za-z][A-Za-z0-9_]*)"/g)) {
        const value = match[1] ?? match[2];
        if (!literals.has(value)) literals.set(value, new Set());
        literals.get(value).add(rel);
      }
    }
  }
  return { literals, scannedFiles, creationFiles, sourceLines };
}

/**
 * Where a source string is referenced ANYWHERE in the backend, excluding the allowlist module itself (which
 * would otherwise "use" every entry and make the check vacuous).
 *
 * Deliberately broader than `collectSourceLiterals`: a source can legitimately reach a link as a TERNARY
 * value (`source: isTokenFlow ? 'mju_token_candidate_subject' : undefined`) or as a DEFAULT parameter
 * (`source = 'sso_national_id_resolution'`), neither of which is a plain `source:` assignment. Scanning for
 * the bare string covers all three forms.
 */
function sourceReferencedOutsideAllowlist(source) {
  const evidenceRoot = path.join(SRC_ROOT, '..', 'tests');
  // Exclude the allowlist module (which lists every entry) AND this test file (which names reserved entries
  // in UNUSED_BY_DESIGN). Either one would make the check self-satisfying and therefore vacuous.
  const excluded = [
    path.join(SRC_ROOT, 'domain', 'identityLink.js'),
    path.join(evidenceRoot, 'identityLinkSourcePolicy.test.js'),
  ].map((file) => path.resolve(file));

  const needle = `'${source}'`;
  for (const root of [SRC_ROOT, evidenceRoot]) {
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root)) {
      if (excluded.includes(path.resolve(file))) continue;
      if (fs.readFileSync(file, 'utf8').includes(needle)) return true;
    }
  }
  return false;
}

test('the scan is NOT vacuous: it finds the identity-link creation paths and their source literals', () => {
  const { literals, scannedFiles, creationFiles, sourceLines } = collectSourceLiterals();
  // A wrong root, a renamed marker, or a too-narrow regex would silently scan nothing and "pass" forever.
  assert.ok(scannedFiles > 20, `expected to scan the source tree, read only ${scannedFiles} files`);
  assert.ok(creationFiles >= 2, `expected at least 2 link-creating files, found ${creationFiles}`);
  assert.ok(sourceLines >= 2, `expected at least 2 source-assigning lines, found ${sourceLines}`);
  assert.ok(
    literals.size >= 2,
    `expected at least 2 source literals, found ${literals.size} (${[...literals.keys()].join(', ')})`,
  );
  // The two sources that genuinely exist in the link-creating paths must be among them, so the assertion
  // above is anchored to reality rather than to any two arbitrary strings.
  assert.ok(literals.has('mju_token_candidate_subject'), 'the MJU token-flow source must be found');
  assert.ok(literals.has('sso_national_id_resolution'), 'the SSO first-login source must be found');
});

test('every source literal in a link-creating code path is in the allowlist', () => {
  const { literals } = collectSourceLiterals();
  const unknown = [...literals.entries()]
    .filter(([source]) => !isKnownSource(source))
    .map(([source, files]) => `${source} (in ${[...files].join(', ')})`);

  assert.deepEqual(
    unknown,
    [],
    'A source literal is used to create an identity link but is not in IDENTITY_LINK_SOURCES. Add it to the '
    + 'allowlist with a comment explaining what evidence it represents, and decide explicitly whether it is '
    + 'machine evidence (then also add it to ENRICHMENT_SOURCES). Offenders:\n'
    + unknown.map((line) => `  ${line}`).join('\n'),
  );
});

test('the allowlist has no dead entries: each is referenced, or declared unused with a reason', () => {
  const unused = IDENTITY_LINK_SOURCES.filter(
    (source) => !sourceReferencedOutsideAllowlist(source) && !UNUSED_BY_DESIGN.has(source),
  );
  assert.deepEqual(
    unused,
    [],
    'An allowlisted source is referenced nowhere outside the allowlist module and is not listed in '
    + 'UNUSED_BY_DESIGN. Remove it, or record why it is reserved. Offenders: ' + unused.join(', '),
  );

  // And every declared-unused entry carries a real reason.
  for (const [source, reason] of UNUSED_BY_DESIGN) {
    assert.ok(IDENTITY_LINK_SOURCES.includes(source), `${source} is declared unused but is not allowlisted`);
    assert.ok(typeof reason === 'string' && reason.length > 20, `${source} needs a written reason`);
    assert.equal(
      sourceReferencedOutsideAllowlist(source),
      false,
      `${source} IS referenced now, so it must be removed from UNUSED_BY_DESIGN`,
    );
  }
});

test('the allowlists are immutable, deduplicated and internally consistent', () => {
  assert.ok(Object.isFrozen(IDENTITY_LINK_SOURCES));
  assert.ok(Object.isFrozen(ENRICHMENT_SOURCES));
  assert.ok(Object.isFrozen(BLOCKED_ENRICHMENT_OUTCOMES));
  assert.ok(Object.isFrozen(BLOCKED_ENRICHMENT_CONFIDENCES));

  assert.equal(IDENTITY_LINK_SOURCES.length, new Set(IDENTITY_LINK_SOURCES).size, 'no duplicate sources');
  assert.equal(ENRICHMENT_SOURCES.length, new Set(ENRICHMENT_SOURCES).size, 'no duplicate enrichment sources');

  // Every enrichment source must be a known source: a source cannot guard approval without being creatable.
  for (const source of ENRICHMENT_SOURCES) {
    assert.ok(isKnownSource(source), `${source} is an enrichment source but not an allowed source`);
    assert.ok(isEnrichmentSource(source));
  }

  // The reverse is NOT required - `operator_review` is known but is not machine evidence - but the
  // distinction must not be accidental, so assert that at least one known source is not an enrichment one.
  assert.ok(
    IDENTITY_LINK_SOURCES.some((source) => !ENRICHMENT_SOURCES.includes(source)),
    'a human-evidence source must remain distinguishable from machine evidence',
  );
});

test('the blocked enrichment outcomes cover what the enrichment tool actually emits', () => {
  // These are the `status` values the MJU person-enrichment scripts write (see
  // docs/IDENTITY_INTEGRATION_AUDIT.md §1/§2). Anything the tool can emit except the clean `found` case must
  // block approval; if the tool grows a new failure status, this list is where it must be registered.
  const EMITTED_BY_TOOL = ['found', 'not_found', 'ambiguous', 'api_error', 'timeout'];
  for (const status of EMITTED_BY_TOOL) {
    if (status === 'found') {
      assert.equal(BLOCKED_ENRICHMENT_OUTCOMES.includes('found'), false, '"found" is the only approvable outcome');
      continue;
    }
    assert.ok(
      BLOCKED_ENRICHMENT_OUTCOMES.includes(status),
      `the enrichment tool can emit "${status}" but it does not block approval`,
    );
  }

  // The two confidence values that mean "not settled" must both block.
  assert.deepEqual([...BLOCKED_ENRICHMENT_CONFIDENCES].sort(), ['ambiguous', 'low']);
});

test('a source is not treated as machine evidence by accident', () => {
  // Whitespace-padded machine sources must still be blocked at approval (the guard is deliberately lenient),
  // even though creation is strict. This asymmetry is documented in the domain module.
  assert.equal(isEnrichmentSource('mju_person_enrich '), true, 'the guard must be lenient');
  assert.equal(isKnownSource('mju_person_enrich '), false, 'creation must be strict');
});
