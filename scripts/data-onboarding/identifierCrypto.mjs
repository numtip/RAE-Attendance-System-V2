/**
 * ESM entry point for the SINGLE National ID contract. The implementation lives in
 * backend/src/security/nationalIdContract.js (CommonJS); nothing here re-implements crypto.
 * Policy: docs/NATIONAL_ID_PROTECTION_POLICY.md
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../../backend/src/security/nationalIdContract.js');

export const {
  CONTRACT_VERSION,
  LOOKUP_DOMAIN,
  AAD_DOMAIN,
  AUDIT_ACTIONS,
  WRITE_LOCK_NAME,
  IdentifierCryptoError,
  canonicalizeNationalId,
  isValidNationalIdChecksum,
  maskNationalId,
  loadIdentifierKeys,
  identifierLookupHmac,
  buildLookup,
  buildLookupCandidates,
  encryptRawIdentifier,
  decryptRawIdentifier,
  buildAuditEvent,
  detectCrossVersionDuplicates,
  planReindex,
  createNationalIdProtector,
} = contract;

/** @deprecated name kept for existing callers; same as canonicalizeNationalId. */
export const normalizeNationalId = contract.canonicalizeNationalId;
