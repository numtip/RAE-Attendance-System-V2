/**
 * Fixture hygiene guard: no CHECKSUM-VALID Thai national id may be committed as a literal.
 *
 * Why this exists
 * ---------------
 * A real Thai national id always passes the mod-11 checksum. So a committed literal that passes it is, by
 * construction, either a real person's id or a value indistinguishable from one. That is exactly what went
 * wrong once: a real `citizenID` (cached by the MJU Person API) was used as a "synthetic" sample in six
 * files of this PUBLIC repository. See `docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`.
 *
 * The rule this enforces: **fixtures use values that FAIL the checksum** (structurally incapable of being a
 * real id), and where a test genuinely needs a checksum-valid value it is DERIVED at runtime (see
 * `validSyntheticNationalId()` in `nationalIdContract.test.js`) rather than committed.
 *
 * Why it canonicalizes before checking
 * -----------------------------------
 * The original leak existed in four encodings: plain ASCII, dashed (`<a checksum-valid id was written here by mistake>`), Thai digits and
 * full-width digits. A guard matching only `\b\d{13}\b` would have found ONE of the four and declared the
 * repo clean. This guard therefore canonicalizes every candidate through the same production
 * `canonicalizeNationalId()` (which handles NFKC, Thai digits and separators) and tests the canonical form.
 *
 * A finding is not always a leak: a 13-digit epoch-millisecond timestamp has a ~1-in-11 chance of passing
 * the checksum. Such a value is added to `ALLOWED_CHECKS_VALID_LITERALS` WITH a written reason, so a genuine
 * exception is recorded rather than silently permitted.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalizeNationalId,
  isValidNationalIdChecksum,
  maskNationalId,
} = require('../src/security/nationalIdContract');

const REPO_ROOT = path.join(
  // Resolve from the module path rather than `__dirname`, which this project's ESLint config does not
  // declare as a global (no other test needs it).
  path.dirname(require.resolve('../src/security/nationalIdContract')),
  '..', '..', '..',
);

/** Directories that carry committed fixtures, samples or documentation of them. */
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'backend', 'src'),
  path.join(REPO_ROOT, 'backend', 'tests'),
  path.join(REPO_ROOT, 'scripts'),
  path.join(REPO_ROOT, 'docs'),
  path.join(REPO_ROOT, 'agent'),
];

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'local']);
const SCAN_EXT = /\.(js|mjs|cjs|ts|md|json|sql|ya?ml)$/i;

/**
 * Checksum-valid values that are ACCEPTED, each with the reason it is not a person's id.
 * Keep this list empty if at all possible; every entry is an exception someone must justify.
 */
const ALLOWED_CHECKS_VALID_LITERALS = new Map([
  // '9900000000000': 'example - remove unless a real reason exists',
]);

/**
 * Candidate runs that could conceal a 13-digit id once canonicalized: ASCII / Thai / full-width digits,
 * optionally separated by the separators the production canonicalizer accepts (space and hyphen).
 */
const CANDIDATE = /[0-9๐-๙０-９][0-9๐-๙０-９\s-]{11,22}/g;

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCAN_EXT.test(entry.name)) yield full;
  }
}

/** Every checksum-valid canonical id committed as a literal, as `{ file, masked }`. Also reports how many files it read. */
function findCommittedValidIds() {
  const findings = [];
  let scanned = 0;
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      scanned += 1;
      for (const candidate of text.match(CANDIDATE) || []) {
        const canonical = canonicalizeNationalId(candidate);
        if (!canonical) continue;
        if (!isValidNationalIdChecksum(canonical)) continue;
        if (ALLOWED_CHECKS_VALID_LITERALS.has(canonical)) continue;
        findings.push({ file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'), masked: maskNationalId(canonical) });
      }
    }
  }
  // De-duplicate by file + masked value so the failure message stays readable.
  const seen = new Set();
  const unique = findings.filter((f) => {
    const key = `${f.file}|${f.masked}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { findings: unique, scanned };
}

test('the guard actually scans the repository (a guard that reads no files would pass trivially)', () => {
  const { findings, scanned } = findCommittedValidIds();
  // A wrong root path would silently scan nothing and report success forever.
  assert.ok(scanned > 100, `expected to scan the backend/docs/scripts/agent trees, but read only ${scanned} files`);
  assert.deepEqual(findings, [], 'guard self-check must run on a clean tree');
});

test('no checksum-valid national id is committed as a literal in code, fixtures or docs', () => {
  const { findings } = findCommittedValidIds();
  assert.deepEqual(
    findings,
    [],
    'A checksum-valid 13-digit value is committed as a literal. Because a real Thai national id always '
    + 'passes the checksum, such a value is either a real person\'s id or indistinguishable from one. '
    + 'Fix: use a checksum-INVALID synthetic value, or derive a valid one at runtime (see '
    + 'nationalIdContract.test.js). If this is a false positive (for example a 13-digit epoch-millisecond '
    + 'timestamp), add it to ALLOWED_CHECKS_VALID_LITERALS with a written reason. Findings (masked):\n'
    + findings.map((f) => `  ${f.file} -> ${f.masked}`).join('\n'),
  );
});

test('the guard is NOT vacuous: it catches each encoding the original leak used', () => {
  // The original leak appeared in four encodings. Prove the guard would catch all four, by canonicalizing
  // synthetic strings built ONLY in memory (no literal is written anywhere).
  const twelve = '000000000001';
  const sum = twelve.split('').reduce((acc, digit, index) => acc + Number(digit) * (13 - index), 0);
  const valid = twelve + String((11 - (sum % 11)) % 10); // checksum-valid, built at runtime

  const THAI = '๐๑๒๓๔๕๖๗๘๙';
  const toThai = (s) => s.replace(/\d/g, (d) => THAI[Number(d)]);
  const toFullWidth = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0xFF10 + Number(d)));
  const dashed = `${valid.slice(0, 1)}-${valid.slice(1, 5)}-${valid.slice(5, 10)}-${valid.slice(10, 12)}-${valid.slice(12)}`;

  assert.equal(isValidNationalIdChecksum(valid), true, 'the runtime-built value must be checksum-valid');

  for (const [label, encoded] of [
    ['plain', valid],
    ['dashed', dashed],
    ['thai digits', toThai(valid)],
    ['full-width', toFullWidth(valid)],
  ]) {
    const matches = encoded.match(CANDIDATE) || [];
    const caught = matches.some((m) => {
      const canonical = canonicalizeNationalId(m);
      return canonical && isValidNationalIdChecksum(canonical);
    });
    assert.equal(caught, true, `the guard must catch the ${label} encoding`);
  }

  // And it must NOT flag a checksum-invalid value, or it would be a false-positive machine.
  const invalid = '9900000000002';
  assert.equal(isValidNationalIdChecksum(invalid), false);
  assert.equal(canonicalizeNationalId(invalid), invalid);
});
