import { expect, test } from 'bun:test';
import { shouldAutomaticallyRetryExpiredAuth } from './auth-retry-policy';
import { authRecoveryCopy } from './recovery-copy';

test('recovery copy never tells one provider to run the other provider command', () => {
  const claude = authRecoveryCopy({ provider: 'claude', reasonCode: 'cli-not-logged-in' });
  expect(claude.userMessage).toContain('claude auth login');
  expect(claude.userMessage.toLowerCase()).not.toContain('codex');
  expect(claude.userMessage).toContain('Check again');
  expect(claude.userMessage).toContain('Retry preserved prompt');

  const codex = authRecoveryCopy({
    provider: 'codex',
    reasonCode: 'access-token-expired',
    automaticRetryUsed: true,
  });
  expect(codex.userMessage).toContain('Codex');
  expect(codex.userMessage).toContain('retried once');
  expect(codex.userMessage.toLowerCase()).not.toContain('claude');
});

test('side-effect copy withholds automatic retry and names no secrets', () => {
  const copy = authRecoveryCopy({
    provider: 'claude',
    reasonCode: 'precedence-named-conflict',
    sideEffectRisk: true,
    env: { ANTHROPIC_API_KEY: 'sk-ant-secret-seed-xyz', ANTHROPIC_AUTH_TOKEN: 'secret-token-value' },
  });
  expect(copy.userMessage).toContain('ANTHROPIC_AUTH_TOKEN');
  expect(copy.userMessage).toContain('may already have done work');
  expect(copy.userMessage).not.toContain('sk-ant-secret-seed-xyz');
  expect(copy.userMessage).not.toContain('secret-token-value');
});

test('automatic expired-auth retry is allowed once and never after a possible side effect', () => {
  expect(shouldAutomaticallyRetryExpiredAuth(false, true)).toBe(true);
  expect(shouldAutomaticallyRetryExpiredAuth(true, true)).toBe(false);
  expect(shouldAutomaticallyRetryExpiredAuth(false, false)).toBe(false);
  expect(shouldAutomaticallyRetryExpiredAuth(true, false)).toBe(false);
});
