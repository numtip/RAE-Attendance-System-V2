/**
 * Tests for the employee-master import guards (F1/F2/F3/F5/F10 per row, F9 global).
 * Synthetic values only; no real person, code, email or national ID appears here.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  GATES,
  BLOCKERS,
  assessImportReadiness,
  assertVerifiedEffectiveFrom,
  assertNationalIdLookupOnly,
  summarizeReadiness,
} = require('../src/domain/employeeMasterImportGuards');

/** A row that is import-ready. Individual tests break exactly one field. */
function readyRow(overrides = {}) {
  return {
    email: 'fixture.person@example.test',
    firstNameTh: 'Fixture',
    lastNameTh: 'Personson',
    employeeType: 'university',
    effectiveFrom: '2026-10-01',
    effectiveFromEvidenceRef: 'fixture-evidence-ref',
    employeeCode: 'RAE-00000001',
    deviceCode: '9001',
    ...overrides,
  };
}

test('a fully evidenced row is ready and reports no blocker', () => {
  const verdict = assessImportReadiness(readyRow());
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.blockers, []);
  assert.deepEqual(verdict.blockedGates, []);
});

test('a missing or malformed email blocks F1', () => {
  for (const email of ['', null, 'not-an-email', 'no-at-sign.test']) {
    const verdict = assessImportReadiness(readyRow({ email }));
    assert.equal(verdict.ready, false);
    assert.deepEqual(verdict.blockedGates, [GATES.EMAIL]);
    assert.equal(verdict.blockers[0].code, BLOCKERS.EMAIL_MISSING_OR_INVALID);
  }
});

test('an email is normalized before the shape check, so case alone does not block', () => {
  const verdict = assessImportReadiness(readyRow({ email: 'Fixture.Person@Example.Test' }));
  assert.equal(verdict.ready, true);
});

test('a placeholder in either name field blocks F2', () => {
  for (const value of ['', '-', 'N/A', 'unknown', 'ไม่ทราบ', '   ']) {
    const asFirst = assessImportReadiness(readyRow({ firstNameTh: value }));
    assert.equal(asFirst.ready, false, `firstNameTh=${JSON.stringify(value)} must block`);
    assert.ok(asFirst.blockedGates.includes(GATES.NAME));

    const asLast = assessImportReadiness(readyRow({ lastNameTh: value }));
    assert.equal(asLast.ready, false, `lastNameTh=${JSON.stringify(value)} must block`);
    assert.ok(asLast.blockedGates.includes(GATES.NAME));
  }
});

test('a single-field name is not silently accepted as a full name', () => {
  const verdict = assessImportReadiness(readyRow({ firstNameTh: 'Fixture', lastNameTh: '' }));
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.blockedGates, [GATES.NAME]);
});

test('an employee_type outside the enum blocks F3 and is never coerced', () => {
  const verdict = assessImportReadiness(readyRow({ employeeType: 'civil-servant' }));
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.blockedGates, [GATES.EMPLOYEE_TYPE]);
  assert.equal(verdict.blockers[0].code, BLOCKERS.EMPLOYEE_TYPE_MISSING_OR_INVALID);
});

test('F5 requires both a date and the evidence that verified it', () => {
  const noDate = assessImportReadiness(readyRow({ effectiveFrom: '' }));
  assert.deepEqual(noDate.blockedGates, [GATES.EFFECTIVE_FROM]);
  assert.equal(noDate.blockers[0].code, BLOCKERS.EFFECTIVE_FROM_UNVERIFIED);

  const noEvidence = assessImportReadiness(readyRow({ effectiveFromEvidenceRef: '' }));
  assert.deepEqual(noEvidence.blockedGates, [GATES.EFFECTIVE_FROM]);
  assert.equal(noEvidence.blockers[0].code, BLOCKERS.EFFECTIVE_FROM_UNVERIFIED);
});

test('F5 rejects a plausible-looking placeholder date even when an evidence reference is supplied', () => {
  for (const effectiveFrom of ['1900-01-01', '1970-01-01', '9999-12-31']) {
    const verdict = assessImportReadiness(readyRow({ effectiveFrom }));
    assert.deepEqual(verdict.blockedGates, [GATES.EFFECTIVE_FROM]);
    assert.equal(verdict.blockers[0].code, BLOCKERS.EFFECTIVE_FROM_IS_PLACEHOLDER);
  }
});

test('F5 rejects a malformed date such as a fiscal year label or a day that does not exist', () => {
  for (const effectiveFrom of ['2569', '2026-02-31', '2026-13-01', '01/10/2026', '2026-10']) {
    const verdict = assessImportReadiness(readyRow({ effectiveFrom }));
    assert.deepEqual(verdict.blockedGates, [GATES.EFFECTIVE_FROM], `${effectiveFrom} must block F5`);
  }
});

test('F10 blocks a missing employee code and never derives one from the device code', () => {
  const verdict = assessImportReadiness(readyRow({ employeeCode: '' }));
  assert.deepEqual(verdict.blockedGates, [GATES.EMPLOYEE_CODE]);
  assert.equal(verdict.blockers[0].code, BLOCKERS.EMPLOYEE_CODE_MISSING);
  // The HIP/device code is present, so the row has attendance evidence but still no employee code.
  assert.equal(verdict.hasAttendanceCode, true);
});

test('all blockers are reported together, not just the first', () => {
  const verdict = assessImportReadiness({
    email: '', firstNameTh: '', lastNameTh: '', employeeType: '', employeeCode: '',
  });
  assert.deepEqual(verdict.blockedGates, [GATES.EMAIL, GATES.NAME, GATES.EMPLOYEE_TYPE, GATES.EFFECTIVE_FROM, GATES.EMPLOYEE_CODE]);
  assert.equal(verdict.blockers.length, 5);
});

test('assertVerifiedEffectiveFrom throws a coded F5 error and accepts an evidenced date', () => {
  assert.equal(
    assertVerifiedEffectiveFrom({ effectiveFrom: '2026-10-01', effectiveFromEvidenceRef: 'ref' }),
    '2026-10-01',
  );
  assert.throws(
    () => assertVerifiedEffectiveFrom({ effectiveFrom: '2026-10-01' }),
    (err) => err.code === BLOCKERS.EFFECTIVE_FROM_UNVERIFIED && err.gate === GATES.EFFECTIVE_FROM,
  );
  assert.throws(
    () => assertVerifiedEffectiveFrom({ effectiveFrom: '1900-01-01', effectiveFromEvidenceRef: 'ref' }),
    (err) => err.code === BLOCKERS.EFFECTIVE_FROM_IS_PLACEHOLDER,
  );
});

test('the national-ID path refuses a raw value and requires a key version on a digest', () => {
  assert.equal(assertNationalIdLookupOnly({ lookupHmac: 'deadbeef', keyVersion: '1' }), true);
  assert.throws(
    () => assertNationalIdLookupOnly({ lookupHmac: 'deadbeef', keyVersion: '1', raw: '9900000000002' }),
    (err) => err.code === 'NATIONAL_ID_RAW_REJECTED' && err.gate === 'F9',
  );
  assert.throws(
    () => assertNationalIdLookupOnly({ lookupHmac: 'deadbeef' }),
    (err) => err.code === 'NATIONAL_ID_KEY_VERSION_MISSING',
  );
  // The error message must not echo the rejected value.
  try {
    assertNationalIdLookupOnly({ raw: '9900000000002' });
  } catch (err) {
    assert.equal(err.message.includes('9900000000002'), false);
  }
});

test('the readiness summary is a gate histogram and carries no row reference', () => {
  const summary = summarizeReadiness([
    assessImportReadiness(readyRow()),
    assessImportReadiness(readyRow({ employeeCode: '' })),
    assessImportReadiness(readyRow({ effectiveFrom: '', employeeCode: '' })),
  ]);
  assert.equal(summary.assessed, 3);
  assert.equal(summary.ready, 1);
  assert.equal(summary.blocked, 2);
  assert.deepEqual(summary.blocked_by_gate, { F10: 2, F5: 1 });
  assert.deepEqual(summary.blocked_by_code, { EMPLOYEE_CODE_MISSING: 2, EFFECTIVE_FROM_UNVERIFIED: 1 });
  assert.equal(JSON.stringify(summary).includes('9001'), false, 'the summary must not carry a code');
});
