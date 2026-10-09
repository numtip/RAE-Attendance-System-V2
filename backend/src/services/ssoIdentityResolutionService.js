const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/httpError');
const { assertSsoGate } = require('./sso/ssoConfig');
const { extractVerifiedSubject } = require('./sso/mjuSubjectAdapter');
const { extractNationalIdFromProfile } = require('./sso/mjuNationalIdAdapter');
const { createIdentityResolutionService } = require('./identityResolutionService');
const { createEmployeeIdentityService } = require('./employeeIdentityService');
const { PROVIDER_MJU_SSO } = require('../domain/identityLink');
const { assertJwtSecret, signAccessToken } = require('./sso/ssoTokens');

function assertEmployeeCanAuthenticate(employee) {
  if (employee.status && employee.status !== 'active') {
    throw new HttpError(403, 'SSO_USER_DISABLED', 'Employee is not active');
  }
  if (employee.lockedUntil && new Date(employee.lockedUntil).getTime() > Date.now()) {
    throw new HttpError(403, 'ACCOUNT_LOCKED', 'This account is locked');
  }
}

async function logSsoIdentityEvent(repositories, entry) {
  if (!repositories.authLogs?.append) return;
  try {
    await repositories.authLogs.append(entry);
  } catch {
    // Session issuance must not fail when audit logging fails.
  }
}

/**
 * Locked identity model: national_id → employee_uid, provider subject in employee_identity_links.
 */
function createSsoIdentityResolutionService(deps) {
  const { config, repositories } = deps;
  const identityResolution = createIdentityResolutionService({ repositories });
  const employeeIdentity = createEmployeeIdentityService({ repositories });

  async function resolveEmployeeByNationalId(nationalIdExtraction) {
    if (nationalIdExtraction.status === 'missing') {
      throw new HttpError(
        403,
        'SSO_NATIONAL_ID_MISSING',
        'MJU profile did not include a citizen ID claim',
      );
    }
    if (nationalIdExtraction.status === 'invalid') {
      throw new HttpError(403, 'SSO_NATIONAL_ID_INVALID', 'Citizen ID claim is not valid');
    }

    try {
      return await employeeIdentity.resolve('national_id', nationalIdExtraction.normalized, {
        actor: 'sso:callback',
        reason: 'sso-login',
      });
    } catch (err) {
      if (err instanceof HttpError && err.code === 'EMPLOYEE_NOT_FOUND') {
        throw new HttpError(403, 'SSO_USER_UNKNOWN', 'No employee matches the MJU identity');
      }
      throw err;
    }
  }

  async function tryResolveByProviderSubject(subject) {
    try {
      return await identityResolution.resolve(PROVIDER_MJU_SSO, subject);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'IDENTITY_UNKNOWN') {
        return null;
      }
      throw err;
    }
  }

  return {
    /**
     * @param {{ profile: object, rawQuery?: object }} input OAuth userinfo (+ optional callback query for adapter guards)
     */
    async issueSessionFromOAuthProfile(input = {}) {
      assertSsoGate(config);
      // The citizen-ID claim name on MJU's userinfo is UNCONFIRMED (docs/SSO_PROTOCOL_EVIDENCE.md). The documented
      // Person-API names are only a development default, so a live provider needs an explicit, operator-confirmed claim.
      if (config.sso.provider !== 'mock' && !String(config.sso.nationalIdClaims || '').trim()) {
        throw new HttpError(503, 'SSO_NOT_READY', 'MJU citizen ID claim name is not confirmed (SSO_NATIONAL_ID_CLAIMS)');
      }
      const profile = input.profile || {};
      const rawQuery = input.rawQuery || {};

      const subjectExtraction = extractVerifiedSubject({
        profile,
        rawQuery,
        subjectContractConfirmed: config.sso.subjectContractConfirmed === true,
      });

      const nationalIdExtraction = extractNationalIdFromProfile(
        profile,
        config.sso.nationalIdClaims,
      );

      let employee = null;
      let link = null;
      let resolutionPath = null;

      let bySubject = null;
      if (subjectExtraction.status === 'verified' && subjectExtraction.subject) {
        bySubject = await tryResolveByProviderSubject(subjectExtraction.subject);
      }

      let employeeByNational = null;
      if (nationalIdExtraction.status === 'present') {
        employeeByNational = await resolveEmployeeByNationalId(nationalIdExtraction);
      }

      if (bySubject && employeeByNational) {
        if (bySubject.employee.employeeUid !== employeeByNational.employeeUid) {
          throw new HttpError(
            409,
            'IDENTITY_SUBJECT_CONFLICT',
            'Provider subject is linked to another employee',
          );
        }
        employee = bySubject.employee;
        link = bySubject.link;
        resolutionPath = 'provider_subject';
      } else if (bySubject) {
        employee = bySubject.employee;
        link = bySubject.link;
        resolutionPath = 'provider_subject';
      } else if (employeeByNational) {
        employee = employeeByNational;
        resolutionPath = 'national_id';

        if (subjectExtraction.status === 'verified' && subjectExtraction.subject) {
          link = await identityResolution.linkProviderSubjectFromSsoLogin({
            providerKey: PROVIDER_MJU_SSO,
            providerSubject: subjectExtraction.subject,
            employeeUid: employee.employeeUid,
            emailSnapshot: profile.email || profile.mail || profile.preferred_username,
            subjectType: subjectExtraction.subjectType || 'opaque',
          });
          await logSsoIdentityEvent(repositories, {
            eventType: 'sso_provider_link',
            employeeUid: employee.employeeUid,
            providerKey: PROVIDER_MJU_SSO,
            resolutionPath: 'national_id_first_login',
            subjectType: subjectExtraction.subjectType || 'opaque',
          });
        }
      } else {
        await resolveEmployeeByNationalId(nationalIdExtraction);
      }

      assertEmployeeCanAuthenticate(employee);

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
        subjectExtraction,
        nationalIdExtraction: {
          status: nationalIdExtraction.status,
          evidence: nationalIdExtraction.evidence,
          claim: nationalIdExtraction.claim,
          masked: nationalIdExtraction.masked,
        },
        link,
        resolutionPath,
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

module.exports = { createSsoIdentityResolutionService };
