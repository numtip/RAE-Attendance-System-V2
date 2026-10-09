const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { assertSsoGate } = require('./sso/ssoConfig');
const { extractVerifiedSubject } = require('./sso/mjuSubjectAdapter');
const { createIdentityResolutionService } = require('./identityResolutionService');
const { assertJwtSecret, signAccessToken } = require('./sso/ssoTokens');

/**
 * Prepared SSO identity chain (not wired to the live HTTP callback).
 *
 * verified MJU subject → identity link → active employee → session tokens
 * RBAC / data scope enforced on subsequent API calls via authorizationService.
 */
function createSsoIdentityChainService(deps) {
  const { config, repositories, extractSubject = extractVerifiedSubject } = deps;
  const identityResolution = createIdentityResolutionService({ repositories });

  return {
    async issueSessionFromVerifiedInput(input = {}) {
      assertSsoGate(config);

      const extraction = extractSubject({
        ...input,
        subjectContractConfirmed: config.sso.subjectContractConfirmed === true,
      });

      if (extraction.status === 'invalid') {
        throw new HttpError(403, 'SSO_SUBJECT_INVALID', extraction.evidence || 'Invalid MJU subject');
      }
      if (extraction.status !== 'verified' || !extraction.subject) {
        throw new HttpError(
          403,
          'SSO_SUBJECT_UNKNOWN',
          extraction.evidence || 'MJU subject contract is unknown',
        );
      }

      const { employee, link } = await identityResolution.resolve(
        extraction.provider,
        extraction.subject,
      );

      assertJwtSecret(config);
      const refreshToken = randomUUID();
      const expiresAt = new Date(Date.now() + config.jwt.refreshTokenDays * 86400000).toISOString();
      await repositories.refreshTokens.save({
        token: refreshToken,
        employeeUid: employee.employeeUid,
        role: employee.role,
        email: employee.email,
        expiresAt,
        revokedAt: null,
      });

      return {
        extraction,
        link,
        accessToken: signAccessToken(config, employee),
        refreshToken,
        employee: {
          employeeUid: employee.employeeUid,
          email: employee.email,
          role: employee.role,
        },
      };
    },
  };
}

module.exports = { createSsoIdentityChainService };
