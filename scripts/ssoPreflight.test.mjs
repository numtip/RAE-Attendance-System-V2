import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateSsoPreflight } from './sso-preflight.mjs';

const SYNTHETIC_CLIENT_ID = 'a46a0b5374b4404a9f71a2397dcab283';
const SAMPLE_CLIENT_ID = '9c04eaddb9e248a095b9050cb929d914';
const SYNTHETIC_HMAC_KEY = 'synthetic-test-only-hmac-key-at-least-32-bytes!!';

function stagingEnv(overrides = {}) {
  return {
    NODE_ENV: 'staging',
    SSO_ENABLED: 'true',
    SSO_CALLBACK_CONFIRMED: 'true',
    SSO_PROVIDER: 'portal',
    SSO_CLIENT_ID: SYNTHETIC_CLIENT_ID,
    SSO_SIGNIN_URL: 'https://sso.mju.ac.th/signin.aspx',
    SSO_SIGNOUT_URL: 'https://sso.mju.ac.th/signout.aspx',
    SSO_TOKEN_URL: 'https://sso.mju.ac.th/token.aspx',
    SSO_ALLOW_UNVERIFIED_CONTRACT: 'true',
    SSO_SUBJECT_CLAIM: 'citizenID',
    SSO_APP_ID: 'rae-attendance-v2',
    SSO_HMAC_KEY: SYNTHETIC_HMAC_KEY,
    SSO_LAWFUL_BASIS_APPROVED: 'true',
    ...overrides,
  };
}

test('empty environment fails closed and reports SSO_DISABLED', () => {
  const report = evaluateSsoPreflight({});
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((item) => item.startsWith('SSO_DISABLED')));
});

test('staging portal configuration passes preflight and never prints secrets', () => {
  const report = evaluateSsoPreflight(stagingEnv());
  assert.equal(report.ready, true);
  assert.equal(report.providerCertified, false);
  assert.equal(report.hmacKeyConfigured, true);
  assert.equal(JSON.stringify(report).includes(SYNTHETIC_HMAC_KEY), false);
});

test('sample client ID and short HMAC keys are refused', () => {
  const sample = evaluateSsoPreflight(stagingEnv({ SSO_CLIENT_ID: SAMPLE_CLIENT_ID }));
  assert.equal(sample.ready, false);
  assert.ok(sample.blockers.some((item) => item.startsWith('SSO_CLIENT_ID_IS_SAMPLE')));

  const shortKey = evaluateSsoPreflight(stagingEnv({ SSO_HMAC_KEY: 'too-short' }));
  assert.equal(shortKey.ready, false);
  assert.ok(shortKey.blockers.some((item) => item.includes('32 bytes')));
});

test('production requires an owner risk-acceptance file covering all unverified contract items', () => {
  const withoutFile = evaluateSsoPreflight(stagingEnv({ NODE_ENV: 'production' }));
  assert.equal(withoutFile.ready, false);
  assert.ok(withoutFile.blockers.some((item) => item.includes('MJU_SSO_OWNER_RISK_ACCEPTANCE')));

  const dir = mkdtempSync(join(tmpdir(), 'rae-sso-risk-'));
  try {
    const riskFile = join(dir, 'risk-acceptance.json');
    writeFileSync(
      riskFile,
      JSON.stringify({
        decision: 'accepted-owner-risk',
        providerCertified: false,
        authorisedBy: 'Test Owner (synthetic)',
        date: '2026-11-17',
        acceptedItems: [
          'C-01',
          'C-02',
          'C-03',
          'C-04',
          'C-05',
          'C-06',
          'C-07',
          'C-09',
          'C-10',
          'C-11',
          'C-12',
          'C-13',
        ],
        controls: ['approved-link gate', 'HMAC subjectKey', 'durable MariaDB attempt store'],
      }),
      'utf8',
    );
    const withFile = evaluateSsoPreflight(
      stagingEnv({
        NODE_ENV: 'production',
        SSO_OWNER_RISK_ACCEPTANCE: riskFile,
        SSO_LOGIN_ATTEMPT_STORE: 'mariadb',
      }),
    );
    assert.equal(withFile.ready, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
