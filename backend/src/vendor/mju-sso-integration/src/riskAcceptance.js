import { readFileSync } from 'node:fs';
import { SsoError, SSO_ERROR_CODES } from './errors.js';
import { CONTRACT_ITEMS, CONTRACT_STATUS } from './contract.js';

/**
 * Owner-accepted residual risk, for running an unverified provider contract in production.
 *
 * The default rule stays: an unverified contract is refused in production. This module is the only
 * way around it, and it is deliberately narrow:
 *
 *   - the acceptance must be a file on disk, named by MJU_SSO_OWNER_RISK_ACCEPTANCE;
 *   - it must name every contract item that currently lacks provider evidence — so adding a new
 *     unverified item silently inherits no acceptance, and startup refuses instead;
 *   - it may not claim `providerCertified: true`. The contract status is derived from
 *     `contract.js`, and a risk acceptance cannot raise it.
 *
 * It records a decision. It does not certify anything.
 */

export const RISK_ACCEPTANCE_DECISION = 'accepted-owner-risk';

const fail = (message) => {
  throw new SsoError(SSO_ERROR_CODES.CONFIG_INVALID, { status: 503, message });
};

/** Contract items with no provider evidence. Derived, never hand-maintained. */
export function unverifiedContractIds(items = CONTRACT_ITEMS) {
  return items.filter((item) => item.status !== CONTRACT_STATUS.VERIFIED).map((item) => item.id);
}

export function loadOwnerRiskAcceptance(path, { items = CONTRACT_ITEMS } = {}) {
  if (typeof path !== 'string' || path.trim() === '') {
    fail('MJU_SSO_OWNER_RISK_ACCEPTANCE is required when an unverified contract is enabled in production');
  }

  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`MJU_SSO_OWNER_RISK_ACCEPTANCE could not be read (${error.code ?? error.message})`);
  }

  if (record?.decision !== RISK_ACCEPTANCE_DECISION) {
    fail(`risk acceptance decision must be "${RISK_ACCEPTANCE_DECISION}"`);
  }
  if (record.providerCertified !== false) {
    fail('a risk acceptance must state providerCertified: false — it cannot certify the contract');
  }
  if (!Array.isArray(record.acceptedItems) || record.acceptedItems.length === 0) {
    fail('risk acceptance must name the accepted contract items');
  }
  if (!Array.isArray(record.controls) || record.controls.length === 0) {
    fail('risk acceptance must name the compensating controls it relies on');
  }
  if (!record.authorisedBy || !record.date) {
    fail('risk acceptance must record who authorised it and when');
  }

  const missing = unverifiedContractIds(items).filter((id) => !record.acceptedItems.includes(id));
  if (missing.length > 0) {
    fail(`risk acceptance does not cover ${missing.join(', ')}`);
  }

  return record;
}
