/**
 * Safe ID card CSV helpers — never log or emit raw national ID values.
 *
 * National ID protection uses the SINGLE shared contract (./identifierCrypto.mjs ->
 * backend/src/security/nationalIdContract.js): canonical input, HMAC-SHA-256 + key version,
 * current/previous key lookup, raw storage disabled by default. Do not re-implement crypto here.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  buildLookup,
  buildLookupCandidates,
  canonicalizeNationalId,
  identifierLookupHmac as contractLookupHmac,
  isValidNationalIdChecksum,
  loadIdentifierKeys,
  maskNationalId as contractMaskNationalId,
} from './identifierCrypto.mjs';

export { loadIdentifierKeys };

const CSV_PATH_DEFAULT = 'database/IDCardRaecsv2027.csv';
const IDENTIFIER_TYPES = new Set(['national_id', 'facescan_id']);
const HMAC_HEX = /^[0-9a-f]{64}$/;

export const maskNationalId = contractMaskNationalId;

export function maskFacescanId(value) {
  const normalized = normalizeFacescanCode(value);
  if (normalized.length >= 2) return `***${normalized.slice(-2)}`;
  return '[redacted]';
}

/** Canonical 13 digits or '' (contract canonicalization; no stripping of arbitrary characters). */
export function normalizeNationalId(raw) {
  return canonicalizeNationalId(raw);
}

/** Thai citizen-ID checksum: onboarding screening rule only (not part of lookup canonicalization). */
export function isValidThaiNationalId(raw) {
  return isValidNationalIdChecksum(canonicalizeNationalId(raw));
}

export function normalizeFacescanCode(raw) {
  return String(raw ?? '').trim();
}

function normalizeIdentifier(idType, rawValue) {
  if (!IDENTIFIER_TYPES.has(idType)) throw new Error(`Unsupported identifier type: ${idType}`);
  if (idType === 'national_id') {
    const normalized = normalizeNationalId(rawValue);
    return isValidThaiNationalId(normalized) ? normalized : '';
  }
  const normalized = normalizeFacescanCode(rawValue);
  return /^\d+$/.test(normalized) ? normalized : '';
}

/** Contract HMAC for one explicit key entry ({ version, key }). */
export function identifierLookupHmac(idType, rawValue, hmacKeyEntry) {
  const value = normalizeIdentifier(idType, rawValue);
  if (!value) throw new Error(`Invalid ${idType}`);
  return contractLookupHmac(idType, value, hmacKeyEntry);
}

/**
 * Staged material for an approved import. national_id => HMAC lookup + key version only (raw storage is
 * DISABLED by default and never staged here). facescan_id is not a protected type: it is stored as a plain
 * id_value on import, so the report only flags that and carries no value.
 */
export function protectIdentifier(idType, rawValue, keys) {
  const value = normalizeIdentifier(idType, rawValue);
  if (!value) throw new Error(`Invalid ${idType}`);
  if (idType === 'national_id') {
    const lookup = buildLookup('national_id', value, keys);
    return {
      idType,
      lookupHmac: lookup.lookup_hmac,
      lookupKeyVersion: lookup.key_version,
      rawStorage: 'DISABLED',
    };
  }
  return { idType, storage: 'plain_id_value_on_import' };
}

export function generateEmployeeUid() {
  return randomUUID();
}

function parseCsvLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

export async function loadIdCardCsv(filePath = CSV_PATH_DEFAULT) {
  const text = await readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) {
    return { headers: [], rows: [] };
  }
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line, index) => {
    const cols = parseCsvLine(line);
    return {
      rowNumber: index + 2,
      idCardCode: cols[0] ?? '',
      facescanCode: cols[1] ?? '',
      displayName: cols[2] ?? '',
      orgUnit: cols[3] ?? '',
    };
  });
  return { headers, rows };
}

export function auditIdCardRows(rows) {
  const issues = [];
  let missingFacescan = 0;
  let invalidNational = 0;
  let invalidFacescan = 0;

  const normalizedRows = rows.map((row) => {
    const nationalId = normalizeNationalId(row.idCardCode);
    const facescanId = normalizeFacescanCode(row.facescanCode);
    if (!nationalId || !isValidThaiNationalId(nationalId)) {
      invalidNational += 1;
      issues.push({
        rowNumber: row.rowNumber,
        code: 'INVALID_NATIONAL_ID',
        masked: maskNationalId(row.idCardCode),
      });
    }
    if (!facescanId) {
      missingFacescan += 1;
      issues.push({ rowNumber: row.rowNumber, code: 'MISSING_FACESCAN_CODE' });
    } else if (!/^\d+$/.test(facescanId)) {
      invalidFacescan += 1;
      issues.push({ rowNumber: row.rowNumber, code: 'INVALID_FACESCAN_FORMAT' });
    }
    return {
      ...row,
      nationalId,
      facescanId,
      rowKey: `${nationalId}|${facescanId}`,
      exactKey: `${nationalId}|${facescanId}|${row.displayName}|${row.orgUnit}`,
    };
  });

  const nationalCounts = new Map();
  const facescanCounts = new Map();
  const exactRowKeys = new Map();
  const pairKeys = new Map();

  for (const row of normalizedRows) {
    if (row.nationalId) {
      nationalCounts.set(row.nationalId, (nationalCounts.get(row.nationalId) || 0) + 1);
    }
    if (row.facescanId) {
      facescanCounts.set(row.facescanId, (facescanCounts.get(row.facescanId) || 0) + 1);
    }
    exactRowKeys.set(row.exactKey, (exactRowKeys.get(row.exactKey) || 0) + 1);
    pairKeys.set(row.rowKey, (pairKeys.get(row.rowKey) || 0) + 1);
  }

  const duplicateCases = [];

  for (const [key, count] of exactRowKeys) {
    if (count > 1) {
      const [nationalId, facescanId] = key.split('|');
      duplicateCases.push({
        classification: 'A',
        label: 'exact duplicate row',
        count,
        maskedNationalId: maskNationalId(nationalId),
        maskedFacescanId: maskFacescanId(facescanId),
        disposition: 'SAFE_TO_DEDUPLICATE',
      });
    }
  }

  for (const [nationalId, count] of nationalCounts) {
    if (count <= 1) continue;
    const facescans = new Set(
      normalizedRows.filter((r) => r.nationalId === nationalId).map((r) => r.facescanId),
    );
    if (facescans.size === 1) {
      if (!duplicateCases.some((d) => d.classification === 'A' && d.maskedNationalId === maskNationalId(nationalId))) {
        duplicateCases.push({
          classification: 'B',
          label: 'same national_id + same facescan_id',
          count,
          maskedNationalId: maskNationalId(nationalId),
          maskedFacescanId: maskFacescanId([...facescans][0]),
          disposition: 'SAFE_TO_DEDUPLICATE',
        });
      }
    } else {
      duplicateCases.push({
        classification: 'C',
        label: 'same national_id + different facescan_id',
        count,
        maskedNationalId: maskNationalId(nationalId),
        maskedFacescanIds: [...facescans].map(maskFacescanId),
        disposition: 'REQUIRES_HUMAN_REVIEW',
      });
    }
  }

  for (const [facescanId, count] of facescanCounts) {
    if (count <= 1) continue;
    const nationals = new Set(
      normalizedRows.filter((r) => r.facescanId === facescanId).map((r) => r.nationalId),
    );
    if (nationals.size > 1) {
      duplicateCases.push({
        classification: 'D',
        label: 'different national_id + same facescan_id',
        count,
        maskedFacescanId: maskFacescanId(facescanId),
        maskedNationalIds: [...nationals].map(maskNationalId),
        disposition: 'REQUIRES_HUMAN_REVIEW',
      });
    }
  }

  const uniqueNationalIds = nationalCounts.size;
  const uniqueFacescanIds = facescanCounts.size;
  const exactDuplicateGroups = [...exactRowKeys.values()].filter((c) => c > 1).length;
  const mappingConflicts = duplicateCases.filter((d) => d.disposition === 'REQUIRES_HUMAN_REVIEW');

  return {
    rowCount: rows.length,
    uniqueNationalIds,
    uniqueFacescanIds,
    missingFacescan,
    invalidNational,
    invalidFacescan,
    exactDuplicateGroups,
    duplicateCases,
    mappingConflicts: mappingConflicts.length,
    issues,
    dedupedRows: dedupeExactRows(normalizedRows),
  };
}

export function dedupeExactRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.exactKey)) continue;
    seen.add(row.exactKey);
    out.push(row);
  }
  return out;
}

function addUid(index, key, employeeUid) {
  if (!key || !employeeUid) return;
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(employeeUid);
}

function assertNoPlaintextNational(value) {
  if (/^\d{13}$/.test(String(value ?? '').trim())) {
    // Plaintext National ID in a snapshot is a contract violation: never match or echo it.
    throw new Error('PLAINTEXT_NATIONAL_ID_IN_SNAPSHOT');
  }
}

/**
 * Index keys. national_id: HMAC only (stored lookup, or candidates for current+previous key) � plaintext lookup
 * is forbidden. facescan_id: plain value (not a protected type).
 */
function identifierCandidateKeys(idType, rawValue, lookupHmac, keys) {
  const out = [];
  if (idType === 'national_id') {
    if (lookupHmac) out.push(`h:${String(lookupHmac).toLowerCase()}`);
    const stored = String(rawValue ?? '').trim().toLowerCase();
    if (HMAC_HEX.test(stored)) out.push(`h:${stored}`);
    const normalized = normalizeIdentifier(idType, rawValue);
    if (normalized && keys) {
      for (const candidate of buildLookupCandidates('national_id', normalized, keys)) out.push(`h:${candidate.lookup_hmac}`);
    }
    return out;
  }
  const normalized = normalizeIdentifier(idType, rawValue);
  if (normalized) out.push(`v:${normalized}`);
  return out;
}

function buildIdentifierIndexes(identifiers, keys) {
  const byType = {
    national_id: new Map(),
    facescan_id: new Map(),
  };
  for (const identifier of identifiers) {
    if (identifier.status && identifier.status !== 'active') continue;
    const idType = identifier.idType ?? identifier.id_type;
    if (!IDENTIFIER_TYPES.has(idType)) continue;
    const employeeUid = identifier.employeeUid ?? identifier.employee_uid;
    const rawValue = identifier.idValue ?? identifier.id_value;
    const lookupHmac = identifier.lookupHmac ?? identifier.lookup_hmac;
    if (idType === 'national_id') assertNoPlaintextNational(rawValue);
    for (const key of identifierCandidateKeys(idType, idType === 'national_id' ? null : rawValue, lookupHmac, null)) {
      addUid(byType[idType], key, employeeUid);
    }
    if (idType === 'national_id' && HMAC_HEX.test(String(rawValue ?? '').trim().toLowerCase())) {
      addUid(byType[idType], `h:${String(rawValue).trim().toLowerCase()}`, employeeUid);
    }
  }
  return byType;
}

function resolveIdentifier(index, idType, rawValue, keys) {
  const employeeUids = new Set();
  const candidateKeys = idType === 'national_id'
    ? (normalizeIdentifier(idType, rawValue) && keys
      ? buildLookupCandidates('national_id', normalizeIdentifier(idType, rawValue), keys).map((c) => `h:${c.lookup_hmac}`)
      : [])
    : identifierCandidateKeys(idType, rawValue, null, keys);
  for (const key of candidateKeys) {
    for (const employeeUid of index[idType].get(key) || []) employeeUids.add(employeeUid);
  }
  return employeeUids;
}

function buildCsvConflictRows(rows) {
  const facescansByNational = new Map();
  const nationalsByFacescan = new Map();
  for (const row of rows) {
    if (!facescansByNational.has(row.nationalId)) facescansByNational.set(row.nationalId, new Set());
    if (!nationalsByFacescan.has(row.facescanId)) nationalsByFacescan.set(row.facescanId, new Set());
    facescansByNational.get(row.nationalId).add(row.facescanId);
    nationalsByFacescan.get(row.facescanId).add(row.nationalId);
  }
  return new Set(rows
    .filter((row) => (
      facescansByNational.get(row.nationalId)?.size > 1
      || nationalsByFacescan.get(row.facescanId)?.size > 1
    ))
    .map((row) => row.rowNumber));
}

export function classifyControlledOnboardingRows(
  dedupedRows,
  { identifiers = [] } = {},
  { keys = null } = {},
) {
  if (!keys && identifiers.some((row) => (row.idType ?? row.id_type) === 'national_id')) {
    throw new Error('HMAC key is required to reconcile protected identifier snapshots');
  }
  const indexes = buildIdentifierIndexes(identifiers, keys);
  const csvConflictRows = buildCsvConflictRows(dedupedRows);
  const counts = {
    CREATE_CANDIDATE: 0,
    NOOP: 0,
    ATTACH_REVIEW: 0,
    HARD_CONFLICT: 0,
  };
  const items = [];

  for (const row of dedupedRows) {
    const nationalValid = isValidThaiNationalId(row.nationalId);
    const facescanValid = /^\d+$/.test(row.facescanId);
    const nationalUids = resolveIdentifier(indexes, 'national_id', row.nationalId, keys);
    const facescanUids = resolveIdentifier(indexes, 'facescan_id', row.facescanId, keys);
    const combinedUids = new Set([...nationalUids, ...facescanUids]);
    let classification;
    let reason;

    if (!nationalValid || !facescanValid) {
      classification = 'HARD_CONFLICT';
      reason = 'VALIDATION_FAILED';
    } else if (csvConflictRows.has(row.rowNumber)) {
      classification = 'HARD_CONFLICT';
      reason = 'CSV_IDENTIFIER_CONFLICT';
    } else if (nationalUids.size > 1 || facescanUids.size > 1) {
      classification = 'HARD_CONFLICT';
      reason = 'EXISTING_IDENTIFIER_AMBIGUOUS';
    } else if (nationalUids.size === 0 && facescanUids.size === 0) {
      classification = 'CREATE_CANDIDATE';
      reason = 'IDENTIFIERS_NOT_FOUND';
    } else if (
      nationalUids.size === 1
      && facescanUids.size === 1
      && combinedUids.size === 1
    ) {
      classification = 'NOOP';
      reason = 'BOTH_IDENTIFIERS_SAME_EMPLOYEE';
    } else if (nationalUids.size === 1 && facescanUids.size === 1) {
      classification = 'HARD_CONFLICT';
      reason = 'IDENTIFIERS_RESOLVE_DIFFERENT_EMPLOYEES';
    } else {
      classification = 'ATTACH_REVIEW';
      reason = nationalUids.size === 1
        ? 'NATIONAL_ID_EXISTS_FACESCAN_MISSING'
        : 'FACESCAN_ID_EXISTS_NATIONAL_ID_MISSING';
    }

    counts[classification] += 1;
    items.push({
      rowNumber: row.rowNumber,
      classification,
      reason,
      employeeUid: combinedUids.size === 1 ? [...combinedUids][0] : null,
      employeeUidAction: classification === 'CREATE_CANDIDATE'
        ? 'GENERATE_UUID_ON_APPROVED_IMPORT'
        : null,
    });
  }

  return { counts, items };
}

export function buildControlledOnboardingDryRun(
  rows,
  { employees = [], identifiers = [] } = {},
  keys,
) {
  const audit = auditIdCardRows(rows);
  const classification = classifyControlledOnboardingRows(
    audit.dedupedRows,
    { employees, identifiers },
    { keys },
  );
  const rowsByNumber = new Map(audit.dedupedRows.map((row) => [row.rowNumber, row]));
  const stagedItems = classification.items.map((item) => {
    const row = rowsByNumber.get(item.rowNumber);
    const canProtect = keys && item.reason !== 'VALIDATION_FAILED';
    return {
      ...item,
      identifiers: canProtect ? [
        protectIdentifier('national_id', row.nationalId, keys),
        protectIdentifier('facescan_id', row.facescanId, keys),
      ] : [],
    };
  });

  return {
    writesDatabase: false,
    sourceRows: audit.rowCount,
    stagedRows: audit.dedupedRows.length,
    exactDuplicateGroups: audit.exactDuplicateGroups,
    validationIssues: audit.issues.map(({ rowNumber, code }) => ({ rowNumber, code })),
    classification: classification.counts,
    secureMaterialPrepared: stagedItems.filter((item) => item.identifiers.length === 2).length,
    items: stagedItems,
  };
}

export function reconcileIdCardToEmployees(dedupedRows, { employees = [], identifiers = [] } = {}, { keys = null } = {}) {
  const byNational = new Map(); // HMAC lookup -> employee_uid (plaintext National ID is never indexed)
  const byFacescan = new Map();
  if (!keys && identifiers.some((row) => (row.idType ?? row.id_type) === 'national_id')) {
    throw new Error('HMAC key is required to reconcile protected identifier snapshots');
  }
  for (const idRow of identifiers) {
    if (idRow.status && idRow.status !== 'active') continue;
    if (idRow.idType === 'national_id' || idRow.id_type === 'national_id') {
      const stored = String(idRow.lookupHmac ?? idRow.lookup_hmac ?? idRow.idValue ?? idRow.id_value ?? '').trim().toLowerCase();
      assertNoPlaintextNational(idRow.idValue ?? idRow.id_value);
      if (HMAC_HEX.test(stored)) byNational.set(stored, idRow.employeeUid ?? idRow.employee_uid);
    }
    if (idRow.idType === 'facescan_id' || idRow.id_type === 'facescan_id') {
      const val = normalizeFacescanCode(idRow.idValue ?? idRow.id_value);
      if (val) byFacescan.set(val, idRow.employeeUid ?? idRow.employee_uid);
    }
  }

  const summary = { RESOLVED: 0, NOT_FOUND: 0, AMBIGUOUS: 0, CONFLICT: 0 };
  const items = [];

  for (const row of dedupedRows) {
    const nationalLookups = row.nationalId && keys
      ? buildLookupCandidates('national_id', row.nationalId, keys).map((c) => c.lookup_hmac)
      : [];
    const uidByNational = nationalLookups.map((h) => byNational.get(h)).find(Boolean) ?? null;
    const uidByFacescan = row.facescanId ? byFacescan.get(row.facescanId) : null;
    let status = 'NOT_FOUND';
    let employeeUid = null;

    if (uidByNational && uidByFacescan && uidByNational !== uidByFacescan) {
      status = 'CONFLICT';
    } else if (uidByNational) {
      status = 'RESOLVED';
      employeeUid = uidByNational;
    } else if (uidByFacescan) {
      status = 'RESOLVED';
      employeeUid = uidByFacescan;
    } else {
      const employee = employees.find((e) => {
        const uid = e.employeeUid ?? e.employee_uid;
        return uid && (uidByNational === uid || byFacescan.get(row.facescanId) === uid);
      });
      if (employee) {
        status = 'RESOLVED';
        employeeUid = employee.employeeUid ?? employee.employee_uid;
      }
    }

    summary[status] += 1;
    items.push({
      rowNumber: row.rowNumber,
      status,
      employeeUid,
      maskedNationalId: maskNationalId(row.nationalId),
      maskedFacescanId: maskFacescanId(row.facescanId),
      orgUnit: row.orgUnit,
    });
  }

  return { summary, items };
}

export function buildImportPlan(dedupedRows, reconciliation) {
  const plan = [];
  for (const item of reconciliation.items) {
    if (item.status !== 'RESOLVED' || !item.employeeUid) continue;
    const row = dedupedRows.find((r) => r.rowNumber === item.rowNumber);
    if (!row) continue;
    plan.push({
      employeeUid: item.employeeUid,
      national_id: {
        action: 'upsert_if_absent',
        masked: item.maskedNationalId,
        sourceSystem: 'IDCardRaecsv2027',
      },
      facescan_id: {
        action: 'upsert_if_absent',
        masked: maskFacescanId(row.facescanId),
        sourceSystem: 'IDCardRaecsv2027',
      },
    });
  }
  return plan;
}
