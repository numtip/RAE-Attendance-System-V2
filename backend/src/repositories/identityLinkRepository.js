/**
 * @typedef {Object} IdentityProviderRow
 * @property {number} id
 * @property {string} providerKey
 * @property {string} name
 * @property {'active'|'disabled'} status
 */

/**
 * @typedef {Object} EmployeeIdentityLinkRow
 * @property {number} id
 * @property {string} employeeUid
 * @property {number} providerId
 * @property {string} providerKey
 * @property {string} providerSubject
 * @property {string} subjectType
 * @property {string|null} emailSnapshot
 * @property {string|null} personnelIdSnapshot
 * @property {string|null} citizenIdHash
 * @property {'candidate'|'approved'|'rejected'|'revoked'} status
 * @property {string} confidence
 * @property {string} source
 * @property {string|null} enrichmentOutcome
 * @property {string|null} approvedBy
 * @property {string|null} approvedAt
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} IdentityLinkRepository
 * @property {(providerKey: string) => Promise<IdentityProviderRow|null>} findProviderByKey
 * @property {(input: object) => Promise<EmployeeIdentityLinkRow>} insertLink
 * @property {(providerKey: string, providerSubject: string) => Promise<EmployeeIdentityLinkRow|null>} findByProviderSubject
 * @property {(id: number) => Promise<EmployeeIdentityLinkRow|null>} findById
 * @property {(employeeUid: string, providerId: number) => Promise<EmployeeIdentityLinkRow|null>} findApprovedForEmployee
 * @property {(id: number, patch: object) => Promise<EmployeeIdentityLinkRow|null>} updateLink
 */

module.exports = {};
