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
      // The MJU token.aspx path builds its own minimal profile (mjuTokenClient) whose citizen-ID key is fixed to
      // `citizenID` (the vendor sample's property name), so it does not depend on SSO_NATIONAL_ID_CLAIMS.
      const fromMjuToken = input.source === 'mju_token';
      if (!fromMjuToken && config.sso.provider !== 'mock' && !String(config.sso.nationalIdClaims || '').trim()) {
        throw new HttpError(503, 'SSO_NOT_READY', 'MJU citizen ID claim name is not confirmed (SSO_NATIONAL_ID_CLAIMS)');
      }
      const profile = input.profile || {};
      const rawQuery = input.rawQuery || {};

      const subjectExtraction = extractVerifiedSubject({
        profile,
        rawQuery,
        subjectContractConfirmed: config.sso.subjectContractConfirmed === true,
      });

      // S9: a citizen ID alone is never enough to open a session. A session needs a verified MJU subject
      // (provider contract confirmed, not `ac`, not an email-shaped or missing subject). Checked before any
      // employee lookup so an unverified login learns nothing about who exists.
      if (subjectExtraction.status === 'invalid') {
        throw new HttpError(403, 'SSO_SUBJECT_INVALID', 'MJU subject is not a valid identity proof');
      }
      if (subjectExtraction.status !== 'verified' || !subjectExtraction.subject) {
        throw new HttpError(403, 'SSO_SUBJECT_NOT_VERIFIED', 'MJU subject is not verified');
      }

      const nationalIdExtraction = extractNationalIdFromProfile(
        profile,
        fromMjuToken ? 'citizenID' : config.sso.nationalIdClaims,
      );

      // token.aspx always returns the citizen ID with the subject: a malformed or absent one is a bad response, not a
      // reason to fall back to the subject alone (throws SSO_NATIONAL_ID_MISSING / SSO_NATIONAL_ID_INVALID).
      if (fromMjuToken && nationalIdExtraction.status !== 'present') {
        await resolveEmployeeByNationalId(nationalIdExtraction);
      }

      let employee = null;
      let link = null;
      let resolutionPath = null;

      const bySubject = await tryResolveByProviderSubject(subjectExtraction.subject);

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
