const { HttpError } = require('../utils/httpError');
const {
  LINK_STATUS,
  SUBJECT_REJECTION,
  normalizeEmail,
  isAuthenticatableStatus,
  enrichmentBlocksApproval,
  rejectionCodeForProviderSubject,
  isKnownSource,
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

  /**
   * The shared subject guard for EVERY path that creates an identity link (hardening ID-6, audit finding F1).
   *
   * Before this existed the rule lived only in the SSO adapter (`services/sso/mjuSubjectAdapter.js`), so the
   * link layer itself accepted an e-mail-shaped subject and the callback `ac`. That was safe only by accident:
   * the adapter happened to run first, and a candidate cannot authenticate. Any other caller - a future
   * enrichment ingestion path, a script, a test helper - bypassed the rule completely.
   *
   * The rejection message never echoes the offending value, so a rejected subject cannot be reflected back
   * into a log or a response.
   */
  function assertUsableProviderSubject(providerSubject, { usesCallbackAc = false } = {}) {
    const code = usesCallbackAc === true
      ? SUBJECT_REJECTION.CALLBACK_AC
      : rejectionCodeForProviderSubject(providerSubject);

    if (code === SUBJECT_REJECTION.REQUIRED) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'providerSubject is required');
    }
    if (code === SUBJECT_REJECTION.MALFORMED) {
      throw new HttpError(
        400,
        'IDENTITY_SUBJECT_MALFORMED',
        'providerSubject must be a string or a finite number',
      );
    }
    if (code === SUBJECT_REJECTION.TOO_LONG) {
      throw new HttpError(
        400,
        'IDENTITY_SUBJECT_TOO_LONG',
        'providerSubject exceeds the maximum accepted length',
      );
    }
    if (code === SUBJECT_REJECTION.CALLBACK_AC) {
      throw new HttpError(
        400,
        'IDENTITY_SUBJECT_IS_CALLBACK_AC',
        'The callback ac marker must not be stored or used as identity',
      );
    }
    if (code === SUBJECT_REJECTION.EMAIL_LIKE) {
      throw new HttpError(
        400,
        'IDENTITY_SUBJECT_IS_EMAIL_LIKE',
        'An e-mail-shaped value is not identity evidence',
      );
    }
  }

  /**
   * Provenance must be a KNOWN source (hardening ID-7, audit finding F2).
   *
   * This is the guard that makes the ambiguity rule unbypassable: `enrichmentBlocksApproval` only applies to a
   * known enrichment source, so before the allowlist a caller could invent a source string and create a link
   * whose `ambiguous` outcome would pass approval. An invented source is now refused at creation.
   *
   * The message deliberately does not echo the rejected value - it is caller-supplied free text.
   */
  function assertKnownSource(source) {
    if (!isKnownSource(source)) {
      throw new HttpError(400, 'IDENTITY_SOURCE_UNKNOWN', 'source is not in the identity-link allowlist');
    }
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
      assertUsableProviderSubject(providerSubject, { usesCallbackAc: input.usesCallbackAc === true });
      assertKnownSource(source);

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
        confidence = 'high',
        evidence,
      } = input;

      if (!providerKey || !providerSubject || !employeeUid) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'providerKey, providerSubject, and employeeUid are required');
      }
      // ID-6: the SAME structural guard as `createCandidate`. This path approves a link, so a bad subject
      // here is strictly worse than a bad candidate: it would grant a session.
      assertUsableProviderSubject(providerSubject);
      assertKnownSource(source);

      // Requirement: "SSO authentication alone must never grant employee mapping approval".
      //
      // An APPROVED link is only created when the caller DECLARES that the protected national-ID lookup
      // resolved to this same employee in this same login. Without the declaration the call fails closed.
      //
      // HONEST LIMITATION, stated rather than implied: this assertion is NOT independently verifiable here.
      // The HMAC lookup happens in the SSO layer, and this function cannot repeat it (it holds no raw
      // identifier). So this is a contract check, not a proof: it stops a caller that simply forgot the
      // lookup, and it stops a future ingestion path from approving silently, but a caller that deliberately
      // lies can still assert it. The durable fix is a dedicated evidence column on
      // `employee_identity_links`, which needs a migration and is still open (S-02). Traceability today is
      // `approvedBy: 'system:sso'` + `source` + `subjectType` + the `sso_provider_link` audit event.
      if (evidence?.nationalIdLookupMatched !== true) {
        throw new HttpError(
          403,
          'IDENTITY_EVIDENCE_REQUIRED',
          'An SSO link is approved only when a matched protected national-ID lookup is declared',
        );
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
        // S9: an existing candidate (or revoked/rejected) link is never promoted here; only a reviewer approves it.
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
        confidence,
        source,
        approvedBy: 'system:sso',
        approvedAt,
      });
    },
  };
}

module.exports = { createIdentityResolutionService };
