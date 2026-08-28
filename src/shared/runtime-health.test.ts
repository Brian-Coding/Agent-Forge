import { expect, test } from 'bun:test';
import {
  AUTH_CONTRACT_VERSION,
  healthContainsSecretLikeValue,
  PROVIDER_AUTH_REASON_CODES,
  unprobedAuthSnapshot,
} from './runtime-health';

test('auth contract version and reason codes are the Slice A baseline', () => {
  expect(AUTH_CONTRACT_VERSION).toBe(1);
  expect(PROVIDER_AUTH_REASON_CODES).toContain('not-probed');
  expect(PROVIDER_AUTH_REASON_CODES).toContain('cli-logged-in');
  expect(PROVIDER_AUTH_REASON_CODES).toContain('access-token-expired');
  expect(PROVIDER_AUTH_REASON_CODES).toContain('named-credential-present');
  expect(unprobedAuthSnapshot('claude', 10)).toMatchObject({
    provider: 'claude',
    state: 'unknown',
    evidence: 'none',
    reasonCode: 'not-probed',
    checkedAt: 10,
  });
});

test('health redaction rejects seeded secrets and raw credential assignments', () => {
  expect(healthContainsSecretLikeValue({ token: 'sk-ant-secret-seed-xyz' })).toBe(true);
  expect(healthContainsSecretLikeValue({ env: 'ANTHROPIC_API_KEY=sk-ant-secret-seed-xyz' })).toBe(true);
  expect(healthContainsSecretLikeValue({ prompt: 'CLAUDE_CODE_OAUTH_TOKEN=abc' })).toBe(true);
  expect(healthContainsSecretLikeValue({
    runtime: { bunVersion: '1.3.14', drift: 'current' },
  })).toBe(false);
});
