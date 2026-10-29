const {
  PROVIDER_MJU_SSO,
  EMAIL_LIKE,
  isEmailShaped,
  isCallbackAcLike,
} = require('../../domain/identityLink');

function result(status, fields) {
  return {
    status,
    provider: PROVIDER_MJU_SSO,
    subject: null,
    subjectType: null,
    evidence: '',
    ...fields,
  };
}

function normalizeQuery(input) {
  if (!input || typeof input !== 'object') return {};
  if (input.query && typeof input.query === 'object') return input.query;
  if (input.rawQuery && typeof input.rawQuery === 'object') return input.rawQuery;
  return input;
}

function profileFrom(input) {
  return input.profile || input.oauthProfile || null;
}

/**
 * Fail-closed MJU subject extraction. Does not call Person API or interpret callback `ac` as identity.
 *
 * @returns {{ status: 'verified'|'unknown'|'invalid', provider: string, subject: string|null, subjectType: string|null, evidence: string }}
 */
function extractVerifiedSubject(input = {}) {
  const query = normalizeQuery(input);
  const profile = profileFrom(input);
  const proposedSubject = input.providerSubject ?? input.subject ?? input.confirmedSubject ?? null;

  if (input.usesCallbackAc === true || isCallbackAcLike(proposedSubject)) {
    return result('invalid', { evidence: 'callback_ac_rejected' });
  }
  if (input.treatQueryAcAsSubject === true && query.ac) {
    return result('invalid', { evidence: 'callback_ac_rejected' });
  }
  if (proposedSubject && query.ac && String(proposedSubject) === String(query.ac)) {
    return result('invalid', { evidence: 'callback_ac_rejected' });
  }

  if (input.emailOnly === true) {
    return result('invalid', { evidence: 'email_only_rejected' });
  }
  if (proposedSubject && isEmailShaped(proposedSubject) && input.allowEmailShapedSubject !== true) {
    return result('invalid', { evidence: 'email_only_rejected' });
  }

  if (profile) {
    const claim = profile.sub || profile.subject || profile.providerSubject;
    const email = profile.email || profile.mail || profile.preferred_username;
    if (claim && (isCallbackAcLike(claim) || (query.ac && String(claim) === String(query.ac)))) {
      return result('invalid', { evidence: 'callback_ac_rejected' });
    }
    if (!claim && email) {
      return result('invalid', { evidence: 'email_only_profile_rejected' });
    }
    if (claim && isEmailShaped(claim) && input.allowEmailShapedSubject !== true) {
      return result('invalid', { evidence: 'email_only_rejected' });
    }
  }

  if (input.subjectContractConfirmed !== true) {
    return result('unknown', { evidence: 'mju_subject_contract_unknown' });
  }

  const confirmed = input.confirmedSubject
    || (profile && (profile.sub || profile.subject || profile.providerSubject));
  if (!confirmed) {
    return result('unknown', { evidence: 'confirmed_contract_missing_subject_claim' });
  }
  if (String(confirmed) === String(query.ac || '')) {
    return result('invalid', { evidence: 'callback_ac_rejected' });
  }
  if (isEmailShaped(confirmed) && input.allowEmailShapedSubject !== true) {
    return result('invalid', { evidence: 'email_only_rejected' });
  }

  return result('verified', {
    subject: String(confirmed),
    subjectType: input.subjectType || 'opaque',
    evidence: input.evidence || 'confirmed_mju_subject_claim',
  });
}

module.exports = { extractVerifiedSubject, EMAIL_LIKE };
