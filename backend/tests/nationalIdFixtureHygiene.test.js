/**
 * Fixture hygiene: no checksum-valid Thai national ID may be committed as a literal.
 *
 * Why this exists
 * ---------------
 * A real Thai national ID always passes the mod-11 checksum. A committed literal that passes it is, by
 * construction, either a real person's ID or a value indistinguishable from one. That distinction does not
 * matter to a reader, an auditor or an attacker, so the repo treats it as a leak either way.
 *
 * This guard was found missing on `main` while doing F9 work: `backend/tests/employeeIdentity.test.js` carried
 * four checksum-valid literals, two of them ending in a suffix that `AGENTS.md` forbids reproducing. Those are
 * now replaced with checksum-invalid synthetics and this test prevents a regression.
 *
 * The rule
 * --------
 * Fixtures use values that **fail** the checksum (structurally incapable of being a real ID). Where a test
 * genuinely needs a checksum-valid value, it is DERIVED at runtime rather than committed.
 *
 * Encodings
 * ---------
 * The earlier leak existed in four encodings (plain, dashed, Thai digits, full-width). A guard matching only
 * `\b\d{13}\b` would find one of the four and declare the repo clean, so every candidate is canonicalised
 * through the same production function before being checked.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalizeNationalId, isValidNationalIdChecksum, maskNationalId } = require('../src/security/nationalIdContract');

// `require.resolve('../src/security/nationalIdContract')` lands in backend/src/security; three levels up is the
// repository root. The self-check below caught this being wrong by one level, which is precisely its job.
const REPO_ROOT = path.join(path.dirname(require.resolve('../src/security/nationalIdContract')), '..', '..', '..');

/** Directories that carry committed fixtures, samples or documentation of them. */
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'backend', 'src'),
  path.join(REPO_ROOT, 'backend', 'tests'),
  path.join(REPO_ROOT, 'scripts'),
  path.join(REPO_ROOT, 'docs'),
];

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'local']);
const SCAN_EXT = /\.(js|mjs|cjs|ts|md|json|sql|ya?ml)$/i;

/** Candidate runs that could conceal a 13-digit ID: ASCII / Thai / full-width digits, with separators. */
const CANDIDATE = /[0-9๐-๙０-９][0-9๐-๙０-９\s-]{10,40}/g;

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

/** Every checksum-valid canonical ID committed as a literal, as `{ file, masked }`. */
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
        findings.push({ file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'), masked: maskNationalId(canonical) });
      }
    }
  }
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
  const { scanned } = findCommittedValidIds();
  assert.ok(scanned > 50, `expected to scan the source trees, but read only ${scanned} files`);
});

test('no checksum-valid national ID is committed as a literal', () => {
  const { findings } = findCommittedValidIds();
  assert.deepEqual(
    findings,
    [],
    'A checksum-valid 13-digit value is committed as a literal. Because a real Thai national ID always passes '
    + 'the checksum, such a value is either a real person\'s ID or indistinguishable from one. Fix: use a '
    + 'checksum-INVALID synthetic value, or derive a valid one at runtime. Findings (masked):\n'
    + findings.map((f) => `  ${f.file} -> ${f.masked}`).join('\n'),
  );
});

test('the guard is NOT vacuous: it catches each encoding the original leak used', () => {
  // Build the encodings in memory from a runtime-derived checksum-valid value. No literal is written anywhere.
  const twelve = '000000000001';
  const sum = twelve.split('').reduce((acc, d, i) => acc + Number(d) * (13 - i), 0);
  const valid = twelve + String((11 - (sum % 11)) % 10);
  assert.equal(isValidNationalIdChecksum(valid), true, 'the runtime value must be checksum-valid');

  const THAI = '๐๑๒๓๔๕๖๗๘๙';
  const toThai = (s) => s.replace(/\d/g, (d) => THAI[Number(d)]);
  const toFullWidth = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
  const dashed = valid.split('').join('-');

  for (const [label, encoded] of [
    ['plain', valid],
    ['dashed', dashed],
    ['thai digits', toThai(valid)],
    ['full-width', toFullWidth(valid)],
  ]) {
    const caught = (encoded.match(CANDIDATE) || []).some((m) => {
      const canonical = canonicalizeNationalId(m);
      return canonical && isValidNationalIdChecksum(canonical);
    });
    assert.equal(caught, true, `the guard must catch the ${label} encoding`);
  }

  // And it must NOT flag a checksum-invalid value, or it would be a false-positive machine.
  assert.equal(isValidNationalIdChecksum('9900000000002'), false);
  assert.equal(canonicalizeNationalId('9900000000002'), '9900000000002');
});
