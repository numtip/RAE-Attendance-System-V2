const { HttpError } = require('../utils/httpError');
const {
  LINK_STATUS,
  normalizeEmail,
  isAuthenticatableStatus,
  enrichmentBlocksApproval,
} = require('../domain/identityLink');

function createIdentityResolutionService(deps) {
  const { repositories } = deps;
  const identityLinks = repositories.identityLinks;
  const employees = repositories.employees;

  async function requireProvider(providerKey) {
    const provider = await identityLinks.findProviderByKey(providerKey);
    if (!provider || provider.status !== 'active') {
      throw new HttpError(403, 'IDENTITY_PROVIDER_DISABLED', 'Identity provider is not available');
    }
    return provider;
  }

  return {
    /**
     * Resolve an MJU SSO subject to an active employee. Fail closed unless link is approved.
     */
    async resolve(providerKey, providerSubject) {
      if (!providerKey || !providerSubject) {
        throw new HttpError(403, 'IDENTITY_UNKNOWN', 'Identity could not be resolved');
      }
      const provider = await requireProvider(providerKey);
      const link = await identityLinks.findByProviderSubject(providerKey, providerSubject);
      if (!link) {
        throw new HttpError(403, 'IDENTITY_UNKNOWN', 'No identity link for provider subject');
      }
      if (!isAuthenticatableStatus(link.status)) {
        throw new HttpError(403, 'IDENTITY_NOT_APPROVED', 'Identity link is not approved for sign-in');
      }

      const profile = await employees.findByUid(link.employeeUid);
      if (!profile) {
        throw new HttpError(403, 'IDENTITY_UNKNOWN', 'Linked employee was not found');
      }
      const employeeRow = profile.email && employees.findByEmail
        ? await employees.findByEmail(profile.email)
        : profile;
      if (!employeeRow) {
        throw new HttpError(403, 'IDENTITY_UNKNOWN', 'Linked employee was not found');
      }
      if (employeeRow.status && employeeRow.status !== 'active') {
        throw new HttpError(403, 'SSO_USER_DISABLED', 'Employee is not active');
      }
      if (employeeRow.lockedUntil && new Date(employeeRow.lockedUntil).getTime() > Date.now()) {
        throw new HttpError(403, 'ACCOUNT_LOCKED', 'This account is locked');
      }

      if (link.emailSnapshot && employeeRow.email) {
        const snapshot = normalizeEmail(link.emailSnapshot);
        const current = normalizeEmail(employeeRow.email);
        if (snapshot && current && snapshot !== current) {
          throw new HttpError(403, 'IDENTITY_EMAIL_MISMATCH', 'Approved link email evidence does not match employee');
        }
      }

      return { provider, link, employee: employeeRow };
    },

    async createCandidate(input) {
      const {
        providerKey,
        providerSubject,
        employeeUid,
        subjectType,
        emailSnapshot,
        personnelIdSnapshot,
        citizenIdHash,
        confidence,
        source,
        enrichmentOutcome,
      } = input;

      if (!providerKey || !providerSubject || !employeeUid || !source) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'providerKey, providerSubject, employeeUid, and source are required');
      }
      if (String(providerSubject).trim() === 'ac' || input.usesCallbackAc === true) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Callback ac must not be stored or used as identity');
      }

      const provider = await requireProvider(providerKey);
      const existing = await identityLinks.findByProviderSubject(providerKey, providerSubject);
      if (existing) {
        throw new HttpError(409, 'IDENTITY_DUPLICATE', 'Provider subject is already linked');
      }

      const approvedForEmployee = await identityLinks.findApprovedForEmployee(employeeUid, provider.id);
      if (approvedForEmployee) {
        throw new HttpError(409, 'IDENTITY_CONFLICT', 'Employee already has an approved link for this provider');
      }

      return identityLinks.insertLink({
        employeeUid,
        providerId: provider.id,
        providerSubject,
        subjectType,
        emailSnapshot: normalizeEmail(emailSnapshot),
        personnelIdSnapshot: personnelIdSnapshot ?? null,
        citizenIdHash: citizenIdHash ?? null,
        status: LINK_STATUS.CANDIDATE,
        confidence: confidence || 'unknown',
        source,
        enrichmentOutcome: enrichmentOutcome ?? null,
      });
    },

    async approve(linkId, { approvedBy, acknowledgeEmailMismatch = false } = {}) {
      if (!approvedBy) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'approvedBy is required');
      }
      const link = await identityLinks.findById(linkId);
      if (!link) {
        throw new HttpError(404, 'NOT_FOUND', 'Identity link was not found');
      }
      if (link.status !== LINK_STATUS.CANDIDATE) {
        throw new HttpError(409, 'IDENTITY_INVALID_STATE', 'Only candidate links can be approved');
      }
      if (enrichmentBlocksApproval(link)) {
        throw new HttpError(403, 'IDENTITY_REVIEW_REQUIRED', 'Ambiguous enrichment cannot be approved without corrected evidence');
      }

      const employee = await employees.findByUid(link.employeeUid);
      if (!employee) {
        throw new HttpError(404, 'NOT_FOUND', 'Employee was not found');
      }
      if (link.emailSnapshot && employee.email) {
        const snapshot = normalizeEmail(link.emailSnapshot);
        const current = normalizeEmail(employee.email);
        if (snapshot && current && snapshot !== current && !acknowledgeEmailMismatch) {
          throw new HttpError(
            409,
            'IDENTITY_EMAIL_MISMATCH',
            'Email evidence does not match employee; explicit acknowledgement is required',
          );
        }
      }

      const duplicateSubject = await identityLinks.findByProviderSubject(link.providerKey, link.providerSubject);
      if (duplicateSubject && duplicateSubject.id !== link.id && duplicateSubject.status === LINK_STATUS.APPROVED) {
        throw new HttpError(409, 'IDENTITY_DUPLICATE', 'Provider subject is already approved for another link');
      }

      const approvedForEmployee = await identityLinks.findApprovedForEmployee(link.employeeUid, link.providerId);
      if (approvedForEmployee && approvedForEmployee.id !== link.id) {
        throw new HttpError(409, 'IDENTITY_CONFLICT', 'Employee already has an approved link for this provider');
      }

      const approvedAt = new Date();
      return identityLinks.updateLink(linkId, {
        status: LINK_STATUS.APPROVED,
        approvedBy,
        approvedAt,
      });
    },

    async reject(linkId, { rejectedBy } = {}) {
      const link = await identityLinks.findById(linkId);
      if (!link) {
        throw new HttpError(404, 'NOT_FOUND', 'Identity link was not found');
      }
      if (link.status !== LINK_STATUS.CANDIDATE) {
        throw new HttpError(409, 'IDENTITY_INVALID_STATE', 'Only candidate links can be rejected');
      }
      return identityLinks.updateLink(linkId, {
        status: LINK_STATUS.REJECTED,
        approvedBy: rejectedBy || null,
        approvedAt: new Date(),
      });
    },

    async revoke(linkId, { revokedBy } = {}) {
      const link = await identityLinks.findById(linkId);
      if (!link) {
        throw new HttpError(404, 'NOT_FOUND', 'Identity link was not found');
      }
      if (link.status !== LINK_STATUS.APPROVED) {
        throw new HttpError(409, 'IDENTITY_INVALID_STATE', 'Only approved links can be revoked');
      }
      return identityLinks.updateLink(linkId, {
        status: LINK_STATUS.REVOKED,
        approvedBy: revokedBy || link.approvedBy,
        approvedAt: new Date(),
      });
    },

    /**
     * First SSO login after national_id resolution: attach opaque provider subject to employee_uid.
     * Fails closed on cross-employee subject reuse.
     */
    async linkProviderSubjectFromSsoLogin(input) {
      const {
        providerKey,
        providerSubject,
        employeeUid,
        subjectType,
        emailSnapshot,
        source = 'sso_national_id_resolution',
      } = input;

      if (!providerKey || !providerSubject || !employeeUid) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'providerKey, providerSubject, and employeeUid are required');
      }
      if (String(providerSubject).trim() === 'ac') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Callback ac must not be stored or used as identity');
      }

      const provider = await requireProvider(providerKey);
      const existing = await identityLinks.findByProviderSubject(providerKey, providerSubject);
      if (existing) {
        if (existing.employeeUid !== employeeUid) {
          throw new HttpError(
            409,
            'IDENTITY_SUBJECT_CONFLICT',
            'Provider subject is linked to another employee',
          );
        }
        if (existing.status === LINK_STATUS.CANDIDATE) {
          return identityLinks.updateLink(existing.id, {
            status: LINK_STATUS.APPROVED,
            approvedBy: 'system:sso',
            approvedAt: new Date(),
          });
        }
        if (!isAuthenticatableStatus(existing.status)) {
          throw new HttpError(403, 'IDENTITY_NOT_APPROVED', 'Identity link is not approved for sign-in');
        }
        return existing;
      }

      const approvedForEmployee = await identityLinks.findApprovedForEmployee(employeeUid, provider.id);
      if (approvedForEmployee && approvedForEmployee.providerSubject !== providerSubject) {
        throw new HttpError(409, 'IDENTITY_CONFLICT', 'Employee already has an approved link for this provider');
      }
      if (approvedForEmployee) {
        return approvedForEmployee;
      }

      const approvedAt = new Date();
      return identityLinks.insertLink({
        employeeUid,
        providerId: provider.id,
        providerSubject,
        subjectType: subjectType || 'opaque',
        emailSnapshot: normalizeEmail(emailSnapshot),
        status: LINK_STATUS.APPROVED,
        confidence: 'high',
        source,
        approvedBy: 'system:sso',
        approvedAt,
      });
    },
  };
}

module.exports = { createIdentityResolutionService };
