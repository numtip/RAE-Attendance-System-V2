/**
 * Slice 1: effective-dated identity mapping (migration 020).
 * Covers the pure validity rules, the repository windows, the identity service and the effect on
 * FaceScan ingestion. No database (fixture repositories only).
 */
process.env.DATA_SOURCE = 'fixture';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/syntheticIdentifierKeys');

const {
  normalizeValidityDate,
  normalizeValidityWindow,
  assertValidWindow,
  isEffectiveOnDate,
  describeValidity,
} = require('../src/domain/identifierValidity');
const { createFixtureRepositories } = require('../src/repositories/fixtureRepositories');
const { createEmployeeIdentityService } = require('../src/services/employeeIdentityService');
const { createFacescanIngestionService } = require('../src/services/facescanIngestionService');

const USER_UID = '22222222-2222-2222-2222-222222222222';

function context() {
  const repositories = createFixtureRepositories();
  return {
    repositories,
    identity: createEmployeeIdentityService({ repositories }),
    ingestion: createFacescanIngestionService({ repositories }),
  };
}

// --- domain ------------------------------------------------------------------

test('normalizeValidityDate accepts ISO strings and Dates, and treats empty values as "no bound"', () => {
  assert.equal(normalizeValidityDate('2026-01-01', 'effective_from'), '2026-01-01');
  assert.equal(normalizeValidityDate(new Date(2026, 0, 1), 'effective_from'), '2026-01-01');
  assert.equal(normalizeValidityDate(null, 'effective_from'), null);
  assert.equal(normalizeValidityDate(undefined, 'effective_from'), null);
  assert.equal(normalizeValidityDate('', 'effective_from'), null);
});

test('normalizeValidityDate rejects bad values without echoing them', () => {
  const bads = ['01/01/2026', '2026-02-31', '2026-13-01', 'not-a-date', 20260101, {}, new Date('invalid')];
  for (const bad of bads) {
    assert.throws(
      () => normalizeValidityDate(bad, 'effective_from'),
      (error) => error.status === 400
        && error.code === 'IDENTIFIER_INVALID_EFFECTIVE_DATE'
        && !String(error.message).includes(String(bad)),
    );
  }
});

test('assertValidWindow rejects a window that ends before it starts', () => {
  assert.throws(
    () => assertValidWindow({ effectiveFrom: '2026-07-01', effectiveTo: '2026-06-30' }),
    (error) => error.status === 400 && error.code === 'IDENTIFIER_INVALID_EFFECTIVE_WINDOW',
  );
  assert.deepEqual(normalizeValidityWindow({ effectiveFrom: '2026-01-01' }), {
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  });
});

test('isEffectiveOnDate treats NULL bounds as open and both ends as inclusive', () => {
  const open = { effectiveFrom: null, effectiveTo: null };
  assert.equal(isEffectiveOnDate(open, '2026-01-01'), true);
  assert.equal(isEffectiveOnDate(open, null), true);

  const window = { effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' };
  assert.equal(isEffectiveOnDate(window, '2025-12-31'), false);
  assert.equal(isEffectiveOnDate(window, '2026-01-01'), true, 'effective_from is inclusive');
  assert.equal(isEffectiveOnDate(window, '2026-06-30'), true, 'effective_to is inclusive');
  assert.equal(isEffectiveOnDate(window, '2026-07-01'), false);
  assert.equal(isEffectiveOnDate(window, null), true, 'a null date disables the filter');

  assert.equal(isEffectiveOnDate({ effectiveFrom: '2026-01-01', effectiveTo: null }, '2099-01-01'), true);
  assert.equal(isEffectiveOnDate({ effectiveFrom: null, effectiveTo: '2026-01-01' }, '2099-01-01'), false);
});

test('describeValidity names why a window does or does not apply', () => {
  assert.equal(describeValidity({ effectiveFrom: null, effectiveTo: null }, '2026-01-01'), 'unbounded');
  assert.equal(describeValidity({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }, '2026-03-01'), 'effective');
  assert.equal(describeValidity({ effectiveFrom: '2026-07-01', effectiveTo: null }, '2026-03-01'), 'not_yet_effective');
  assert.equal(describeValidity({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }, '2026-08-01'), 'expired');
});

// --- repository + service ----------------------------------------------------

test('resolve honours the validity window when onDate is given', async () => {
  const { identity } = context();
  await identity.linkIdentifier({
    employeeUid: USER_UID,
    idType: 'facescan_id',
    idValue: 'FS-WINDOW-001',
    sourceSystem: 'import',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-06-30',
    actor: 'operator:test',
    reason: 'link:test',
  });

  assert.equal(await identity.resolveUid('facescan_id', 'FS-WINDOW-001', { onDate: '2026-03-01' }), USER_UID);
  await assert.rejects(
    () => identity.resolveUid('facescan_id', 'FS-WINDOW-001', { onDate: '2026-08-01' }),
    (error) => error.status === 404 && error.code === 'EMPLOYEE_NOT_FOUND',
  );
  await assert.rejects(
    () => identity.resolveUid('facescan_id', 'FS-WINDOW-001', { onDate: '2025-12-31' }),
    (error) => error.status === 404 && error.code === 'EMPLOYEE_NOT_FOUND',
  );
  // No onDate keeps the pre-migration behaviour: the window is not applied.
  assert.equal(await identity.resolveUid('facescan_id', 'FS-WINDOW-001'), USER_UID);
});

test('the validity window is visible on listIdentifiers', async () => {
  const { identity } = context();
  await identity.linkIdentifier({
    employeeUid: USER_UID,
    idType: 'facescan_id',
    idValue: 'FS-WINDOW-002',
    sourceSystem: 'import',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-06-30',
    actor: 'operator:test',
    reason: 'link:test',
  });
  const rows = await identity.listIdentifiers(USER_UID);
  const row = rows.find((item) => item.idValue === 'FS-WINDOW-002');
  assert.equal(row.effectiveFrom, '2026-01-01');
  assert.equal(row.effectiveTo, '2026-06-30');
});

test('linkIdentifier rejects an inverted window and stores an open one as null', async () => {
  const { identity } = context();
  await assert.rejects(
    () => identity.linkIdentifier({
      employeeUid: USER_UID,
      idType: 'facescan_id',
      idValue: 'FS-WINDOW-003',
      sourceSystem: 'import',
      effectiveFrom: '2026-07-01',
      effectiveTo: '2026-06-30',
    }),
    (error) => error.status === 400 && error.code === 'IDENTIFIER_INVALID_EFFECTIVE_WINDOW',
  );
  const link = await identity.linkIdentifier({
    employeeUid: USER_UID,
    idType: 'facescan_id',
    idValue: 'FS-WINDOW-004',
    sourceSystem: 'import',
    effectiveFrom: '2026-01-01',
  });
  assert.equal(link.effectiveFrom, '2026-01-01');
  assert.equal(link.effectiveTo, null);
});

test('explainResolution separates "expired" from "never mapped" and never echoes the value', async () => {
  const { identity } = context();
  await identity.linkIdentifier({
    employeeUid: USER_UID,
    idType: 'facescan_id',
    idValue: 'FS-WINDOW-005',
    sourceSystem: 'import',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-06-30',
  });

  const expired = await identity.explainResolution('facescan_id', 'FS-WINDOW-005', { onDate: '2026-08-01' });
  assert.equal(expired.outcome, 'not_effective');
  assert.equal(expired.reason, 'expired');
  assert.equal(expired.employeeUid, USER_UID);

  const future = await identity.explainResolution('facescan_id', 'FS-WINDOW-005', { onDate: '2025-01-01' });
  assert.equal(future.outcome, 'not_effective');
  assert.equal(future.reason, 'not_yet_effective');

  const effective = await identity.explainResolution('facescan_id', 'FS-WINDOW-005', { onDate: '2026-03-01' });
  assert.equal(effective.outcome, 'resolved');

  const unknown = await identity.explainResolution('facescan_id', 'FS-DOES-NOT-EXIST', { onDate: '2026-03-01' });
  assert.equal(unknown.outcome, 'unmapped');
  assert.equal(unknown.employeeUid, null);

  const blob = JSON.stringify([expired, future, effective, unknown]);
  assert.equal(blob.includes('FS-WINDOW-005'), false, 'diagnostics are metadata only');
  assert.equal(blob.includes('FS-DOES-NOT-EXIST'), false);
});

test('unlinkIdentifier can close the window and records a metadata-only validity event', async () => {
  const { identity } = context();
  const link = await identity.linkIdentifier({
    employeeUid: USER_UID,
    idType: 'facescan_id',
    idValue: 'FS-WINDOW-006',
    sourceSystem: 'import',
    effectiveFrom: '2026-01-01',
  });

  assert.deepEqual(await identity.listValidityEvents({ employeeUid: USER_UID }), []);

  const closed = await identity.unlinkIdentifier({
    id: link.id,
    employeeUid: USER_UID,
    effectiveTo: '2026-06-30',
    actor: 'operator:test',
    reason: 'unlink:test',
  });
  assert.equal(closed.status, 'inactive');
  assert.equal(closed.effectiveTo, '2026-06-30');

  await assert.rejects(
    () => identity.resolveUid('facescan_id', 'FS-WINDOW-006', { onDate: '2026-03-01' }),
    (error) => error.code === 'EMPLOYEE_NOT_FOUND',
  );

  const events = await identity.listValidityEvents({ employeeUid: USER_UID });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'effective_change');
  assert.equal(events[0].effectiveTo, '2026-06-30');
  assert.equal(events[0].employeeUid, USER_UID);
  assert.equal(JSON.stringify(events).includes('FS-WINDOW-006'), false, 'no identifier value in the audit trail');
});

// --- ingestion integration ---------------------------------------------------

test('FaceScan ingestion resolves through the mapping effective on the scan date', async () => {
  const { identity, ingestion } = context();
  await identity.linkIdentifier({
    employeeUid: USER_UID,
    idType: 'facescan_id',
    idValue: 'FS-WINDOW-100',
    sourceSystem: 'import',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-06-30',
  });

  const batch = await ingestion.startBatch({});
  const { results } = await ingestion.ingestCheckinoutBatch(batch.batchUid, [
    { USERID: 'FS-WINDOW-100', CHECKTIME: '2026-03-01 08:00:00', SensorID: 'S1' },
    { USERID: 'FS-WINDOW-100', CHECKTIME: '2026-09-01 08:00:00', SensorID: 'S1' },
  ]);

  assert.equal(results[0].outcome, 'inserted');
  assert.equal(results[0].resolutionStatus, 'resolved');
  assert.equal(results[0].employeeUid, USER_UID);
  assert.equal(results[1].outcome, 'inserted');
  assert.equal(results[1].resolutionStatus, 'unmapped', 'a scan outside the window must not be attributed');
});
