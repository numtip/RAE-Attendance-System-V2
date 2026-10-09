/**
 * Identity-kind mapping for the IDCardRaecsv2027 batch (dry-run, no database, no network).
 *
 *   MJU         row matches exactly one MJU-verified personnel record (by protected National ID lookup, never by name)
 *               => primary identity = personnel_id (source mju_person_api); facescan_id attached as attendance source
 *   HIP         contractor with no MJU data (approved policy) => primary identity = HIP/FaceScan id from the CSV
 *               => NO personnel_id is ever created, NO SSO subject is created or required
 *   UNRESOLVED  anything that cannot be classified safely; kept in the list, never dropped
 *
 * National ID handling follows the single contract (HMAC + key version, no plaintext). The report is masked;
 * raw identifiers exist only in the in-memory `staged` result for the (separately approved) import step.
 */
import { createRequire } from 'node:module';
import {
  buildLookup,
  buildLookupCandidates,
  canonicalizeNationalId,
  isValidNationalIdChecksum,
  maskNationalId,
} from './identifierCrypto.mjs';

const require = createRequire(import.meta.url);
const {
  IDENTITY_KIND,
  MJU_PERSONNEL_SOURCE,
  HIP_BATCH_SOURCE,
  ssoPolicyForKind,
} = require('../../backend/src/domain/identityKind.js');

export { IDENTITY_KIND, MJU_PERSONNEL_SOURCE, HIP_BATCH_SOURCE };

const HEX_LOOKUP = /^[0-9a-f]{64}$/;
const HIP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const UNRESOLVED_REASONS = Object.freeze([
  'NATIONAL_ID_INVALID',
  'NATIONAL_ID_CHECKSUM_INVALID',
  'CSV_NATIONAL_MULTIPLE_FACESCAN',
  'CSV_FACESCAN_SHARED_BY_MULTIPLE_NATIONALS',
  'HIP_ID_MISSING',
  'HIP_ID_INVALID',
  'NAMESPACE_COLLISION_PERSONNEL_ID',
  'FACESCAN_ID_ALREADY_ASSIGNED',
  'EXISTING_IDENTIFIERS_CONFLICT',
  'MJU_MATCH_AMBIGUOUS',
  'MJU_PERSONNEL_ID_DUPLICATE',
  'MJU_SOURCE_NOT_AUTHORITATIVE',
  'HIP_POLICY_NOT_APPROVED',
  'HIP_ID_FIELD_UNVERIFIED',
  'MJU_ABSENCE_NOT_VERIFIED',
]);

function addTo(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function assertNoPlaintextNational(value) {
  if (/^\d{13}$/.test(String(value ?? '').trim())) {
    throw new Error('PLAINTEXT_NATIONAL_ID_IN_SNAPSHOT');
  }
}

function indexExisting(existingIdentifiers, keys) {
  const byNational = new Map();
  const byFacescan = new Map();
  const byPersonnel = new Map();
  for (const row of existingIdentifiers) {
    if (row.status && row.status !== 'active') continue;
    const idType = row.idType ?? row.id_type;
    const uid = row.employeeUid ?? row.employee_uid;
    const value = row.idValue ?? row.id_value;
    if (idType === 'national_id') {
      assertNoPlaintextNational(value);
      const stored = String(row.lookupHmac ?? row.lookup_hmac ?? value ?? '').trim().toLowerCase();
      if (HEX_LOOKUP.test(stored)) addTo(byNational, stored, uid);
    } else if (idType === 'facescan_id') {
      addTo(byFacescan, String(value ?? '').trim(), uid);
    } else if (idType === 'personnel_id') {
      addTo(byPersonnel, String(value ?? '').trim(), uid);
    }
  }
  return { byNational, byFacescan, byPersonnel, keys };
}

function indexMjuSource(mjuSource, keys) {
  const authoritative = mjuSource?.authoritative === true;
  const byLookup = new Map(); // lookup -> Set(personnelId)
  const lookupsByPersonnel = new Map(); // personnelId -> Set(lookup)
  let unusable = 0;
  for (const record of mjuSource?.records ?? []) {
    const personnelId = String(record?.personnelId ?? '').trim();
    const national = canonicalizeNationalId(record?.nationalId);
    if (!personnelId || !national) {
      unusable += 1;
      continue;
    }
    const { lookup_hmac: lookup } = buildLookup('national_id', national, keys);
    addTo(byLookup, lookup, personnelId);
    addTo(lookupsByPersonnel, personnelId, lookup);
  }
  const duplicatePersonnel = new Set(
    [...lookupsByPersonnel].filter(([, lookups]) => lookups.size > 1).map(([personnelId]) => personnelId),
  );
  return {
    authoritative,
    byLookup,
    duplicatePersonnel,
    personnelValues: new Set(lookupsByPersonnel.keys()),
    lookupsByPersonnel,
    records: (mjuSource?.records ?? []).length,
    unusable,
  };
}

/**
 * @param {Array<{rowNumber:number, nationalId:string, facescanId:string}>} rows parsed CSV rows (never written back)
 * @param {object} options
 * @param {object} options.keys                      loadIdentifierKeys() result (HMAC lookups; fail closed without it)
 * @param {{authoritative:boolean, records:Array<{personnelId:string, nationalId:string}>}} [options.mjuSource]
 * @param {{approvalRef?:string, acceptUnverifiedMjuAbsence?:boolean}} [options.hipPolicy]
 * @param {Array} [options.existingIdentifiers]      employee_identifier snapshot (HMAC national, plain facescan/personnel)
 */
export function buildIdentityKindMapping(rows, {
  keys,
  mjuSource = null,
  hipPolicy = {},
  existingIdentifiers = [],
  confirmedScope = null,
} = {}) {
  if (!Array.isArray(rows)) throw new Error('rows must be an array');
  if (!keys) throw new Error('HMAC key is required to build identity mapping');

  const mju = indexMjuSource(mjuSource, keys);
  const existing = indexExisting(existingIdentifiers, keys);
  const hipApproved = Boolean(String(hipPolicy?.approvalRef ?? '').trim());
  // Evidence that CSV 'Facescan Code' really is the HIP USERID (docs/HIP_ID_MAPPING_EVIDENCE.md). Required before the
  // HIP id is used as identity reference or attached as an attendance source.
  const hipIdEvidence = Boolean(String(hipPolicy?.hipIdFieldEvidenceRef ?? '').trim());
  const hipBasis = mju.authoritative
    ? 'MJU_NEGATIVE_AUTHORITATIVE'
    : (hipPolicy?.acceptUnverifiedMjuAbsence === true ? 'OPERATOR_CONFIRMED_NO_MJU_ACCOUNT' : null);

  // 1) normalize + collapse exact duplicate rows (same ID card + same HIP id)
  const unique = [];
  const seenPair = new Map();
  const collapsedRowNumbers = [];
  for (const row of rows) {
    const national = canonicalizeNationalId(row?.nationalId);
    const facescan = String(row?.facescanId ?? '').trim();
    const pairKey = national ? `${national}\u0000${facescan}` : `invalid:${row?.rowNumber}`;
    if (national && seenPair.has(pairKey)) {
      collapsedRowNumbers.push(row.rowNumber);
      continue;
    }
    seenPair.set(pairKey, true);
    unique.push({ rowNumber: row?.rowNumber, national, facescan, rawNationalPresent: String(row?.nationalId ?? '').trim() !== '' });
  }

  // 2) CSV-internal collisions among unique rows
  const facesByNational = new Map();
  const nationalsByFace = new Map();
  for (const row of unique) {
    if (row.national) addTo(facesByNational, row.national, row.facescan);
    if (row.facescan) addTo(nationalsByFace, row.facescan, row.national || `invalid:${row.rowNumber}`);
  }

  const items = [];
  const staged = [];
  const counts = { MJU: 0, HIP: 0, UNRESOLVED: 0 };
  const unresolvedReasons = {};
  const hipBasisCounts = {};
  const existingActions = { ALREADY_MAPPED: 0, ATTACH_REVIEW: 0 };
  let hipEligibleStructural = 0;

  const processRow = (row) => {
    const maskedNationalId = row.national ? maskNationalId(row.national) : '[invalid]';
    const done = (kind, reason, extra = {}) => {
      counts[kind] += 1;
      if (reason) unresolvedReasons[reason] = (unresolvedReasons[reason] || 0) + 1;
      items.push({
        rowNumber: row.rowNumber,
        kind,
        reason: reason || null,
        maskedNationalId,
        primaryIdentity: kind === 'MJU' ? 'personnel_id' : (kind === 'HIP' ? 'facescan_id' : null),
        // Attendance (HIP) eligibility is separate from MJU SSO eligibility: contractors need no MJU account.
        attendanceEligible: kind !== IDENTITY_KIND.UNRESOLVED && hipIdEvidence,
        sso: ssoPolicyForKind(kind),
        ...extra,
      });
    };

    if (!row.national) return done('UNRESOLVED', 'NATIONAL_ID_INVALID');
    if (!isValidNationalIdChecksum(row.national)) return done('UNRESOLVED', 'NATIONAL_ID_CHECKSUM_INVALID');
    if (facesByNational.get(row.national).size > 1) return done('UNRESOLVED', 'CSV_NATIONAL_MULTIPLE_FACESCAN');
    if (!row.facescan) return done('UNRESOLVED', 'HIP_ID_MISSING');
    if (!HIP_ID_PATTERN.test(row.facescan)) return done('UNRESOLVED', 'HIP_ID_INVALID');
    if (nationalsByFace.get(row.facescan).size > 1) return done('UNRESOLVED', 'CSV_FACESCAN_SHARED_BY_MULTIPLE_NATIONALS');

    const { lookup_hmac: currentLookup, key_version: keyVersion } = buildLookup('national_id', row.national, keys);
    const candidateLookups = buildLookupCandidates('national_id', row.national, keys).map((c) => c.lookup_hmac);

    // MJU match (by protected lookup only)
    const personnelIds = new Set();
    for (const lookup of candidateLookups) for (const id of mju.byLookup.get(lookup) ?? []) personnelIds.add(id);

    // Namespace collision: HIP value equals a personnel_id that belongs to somebody else
    const mjuHolders = mju.lookupsByPersonnel.get(row.facescan);
    const sameMjuHolder = mjuHolders && [...mjuHolders].every((lookup) => candidateLookups.includes(lookup));
    const existingPersonnelHolders = existing.byPersonnel.get(row.facescan);
    const ownExistingUids = new Set();
    for (const lookup of candidateLookups) for (const uid of existing.byNational.get(lookup) ?? []) ownExistingUids.add(uid);
    const foreignExistingPersonnel = existingPersonnelHolders
      && [...existingPersonnelHolders].some((uid) => !ownExistingUids.has(uid));
    if ((mjuHolders && !sameMjuHolder) || foreignExistingPersonnel) {
      return done('UNRESOLVED', 'NAMESPACE_COLLISION_PERSONNEL_ID');
    }

    // Existing employee_identifier evidence
    const faceUids = existing.byFacescan.get(row.facescan) ?? new Set();
    const allUids = new Set([...ownExistingUids, ...faceUids]);
    let existingInfo = {};
    if (ownExistingUids.size > 1 || (ownExistingUids.size === 1 && faceUids.size && ![...faceUids].every((uid) => ownExistingUids.has(uid)))) {
      return done('UNRESOLVED', 'EXISTING_IDENTIFIERS_CONFLICT');
    }
    if (ownExistingUids.size === 0 && faceUids.size > 0) return done('UNRESOLVED', 'FACESCAN_ID_ALREADY_ASSIGNED');
    if (allUids.size === 1) {
      const action = ownExistingUids.size === 1 && faceUids.size === 1 ? 'ALREADY_MAPPED' : 'ATTACH_REVIEW';
      existingActions[action] += 1;
      existingInfo = { existingAction: action };
    }

    // Classification
    let kind;
    let basis = null;
    if (personnelIds.size > 1) return done('UNRESOLVED', 'MJU_MATCH_AMBIGUOUS');
    if (personnelIds.size === 1) {
      const [personnelId] = personnelIds;
      if (mju.duplicatePersonnel.has(personnelId)) return done('UNRESOLVED', 'MJU_PERSONNEL_ID_DUPLICATE');
      if (!mju.authoritative) return done('UNRESOLVED', 'MJU_SOURCE_NOT_AUTHORITATIVE');
      kind = IDENTITY_KIND.MJU;
      staged.push({
        rowNumber: row.rowNumber,
        kind,
        employeeUid: existingInfo.existingAction ? 'EXISTING' : 'GENERATE_UUID_ON_APPROVED_IMPORT',
        identifiers: [
          { idType: 'personnel_id', idValue: personnelId, sourceSystem: MJU_PERSONNEL_SOURCE, isPrimary: true },
          { idType: 'national_id', lookupHmac: currentLookup, lookupKeyVersion: keyVersion, sourceSystem: HIP_BATCH_SOURCE, isPrimary: false },
        ].concat(hipIdEvidence
          ? [{ idType: 'facescan_id', idValue: row.facescan, sourceSystem: HIP_BATCH_SOURCE, isPrimary: false }]
          : []),
      });
    } else {
      hipEligibleStructural += 1; // structurally valid, no MJU match; still needs the policy gate below
      if (!hipApproved) return done('UNRESOLVED', 'HIP_POLICY_NOT_APPROVED', { hipEligible: true, ...existingInfo });
      if (!hipIdEvidence) return done('UNRESOLVED', 'HIP_ID_FIELD_UNVERIFIED', { hipEligible: true, ...existingInfo });
      if (!hipBasis) return done('UNRESOLVED', 'MJU_ABSENCE_NOT_VERIFIED', { hipEligible: true, ...existingInfo });
      kind = IDENTITY_KIND.HIP;
      basis = hipBasis;
      hipBasisCounts[basis] = (hipBasisCounts[basis] || 0) + 1;
      staged.push({
        rowNumber: row.rowNumber,
        kind,
        employeeUid: existingInfo.existingAction ? 'EXISTING' : 'GENERATE_UUID_ON_APPROVED_IMPORT',
        identifiers: [
          { idType: 'facescan_id', idValue: row.facescan, sourceSystem: HIP_BATCH_SOURCE, isPrimary: true },
          { idType: 'national_id', lookupHmac: currentLookup, lookupKeyVersion: keyVersion, sourceSystem: HIP_BATCH_SOURCE, isPrimary: false },
        ],
      });
    }
    done(kind, null, { basis, ...existingInfo });
  };
  unique.forEach(processRow);

  assertStagedInvariants(staged);

  return {
    report: {
      mode: 'dry-run',
      writesDatabase: false,
      hipPolicy: { approved: hipApproved, basis: hipBasis, idFieldEvidence: hipIdEvidence },
      mjuSource: { authoritative: mju.authoritative, records: mju.records, unusableRecords: mju.unusable },
      input: {
        rows: rows.length,
        uniqueRows: unique.length,
        duplicateRowsCollapsed: collapsedRowNumbers.length,
        collapsedRowNumbers,
        uniqueNationalIds: new Set(unique.map((r) => r.national).filter(Boolean)).size,
        uniqueHipIds: new Set(unique.map((r) => r.facescan).filter(Boolean)).size,
      },
      // The confirmed scope is the human-approved unique-employee count (not a hard-coded legacy number).
      scope: {
        confirmedUniqueEmployees: confirmedScope,
        uniqueRows: unique.length,
        matchesConfirmedScope: confirmedScope == null ? null : unique.length === confirmedScope,
      },
      counts,
      eligibility: {
        attendance: hipIdEvidence ? counts.MJU + counts.HIP : 0,
        ssoNotRequired: counts.HIP,
        ssoEligibleOnFirstMjuLogin: counts.MJU,
        ssoRequiredForAnyone: 0,
      },
      total: unique.length,
      hipEligibleStructural,
      hipBasis: hipBasisCounts,
      unresolvedReasons,
      existingActions,
      invariants: {
        syntheticPersonnelIds: 0,
        ssoSubjectsCreated: 0,
        ssoRequired: 0,
        plaintextNationalIds: 0,
        rawNationalIdStorage: 'DISABLED',
      },
      items,
    },
    staged,
  };
}

/** Defense in depth: refuses a staged set that would break the identity-kind contract. */
export function assertStagedInvariants(staged) {
  const seen = new Set();
  for (const entry of staged) {
    const personnel = entry.identifiers.filter((i) => i.idType === 'personnel_id');
    if (entry.kind === IDENTITY_KIND.HIP && personnel.length) throw new Error('INVARIANT_HIP_WITH_PERSONNEL_ID');
    if (entry.kind === IDENTITY_KIND.MJU && personnel.length !== 1) throw new Error('INVARIANT_MJU_PERSONNEL_ID_COUNT');
    for (const id of personnel) {
      if (id.sourceSystem !== MJU_PERSONNEL_SOURCE) throw new Error('INVARIANT_PERSONNEL_ID_SOURCE');
    }
    for (const id of entry.identifiers) {
      if (id.idType === 'national_id' && (id.idValue !== undefined || !HEX_LOOKUP.test(id.lookupHmac))) {
        throw new Error('INVARIANT_NATIONAL_ID_NOT_PROTECTED');
      }
      const key = `${id.idType}\u0000${id.idValue ?? id.lookupHmac}`;
      if (seen.has(key)) throw new Error(`INVARIANT_DUPLICATE_${id.idType.toUpperCase()}`);
      seen.add(key);
    }
    if ('sso' in entry || 'ssoSubject' in entry || 'identityLink' in entry) throw new Error('INVARIANT_SSO_SUBJECT_STAGED');
  }
}
