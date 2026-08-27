import { expect, test } from 'bun:test';
import type { ProviderAuthSnapshot } from '../../shared/runtime-health';
import { decideAuthGate } from './auth-gate';

function snapshot(overrides: Partial<ProviderAuthSnapshot>): ProviderAuthSnapshot {
  return {
    provider: 'claude',
    state: 'unknown',
    credentialMode: 'unknown',
    evidence: 'none',
    reasonCode: 'not-probed',
    checkedAt: 1,
    ...overrides,
  };
}

test('the gate blocks only definitive auth failures', () => {
  expect(decideAuthGate(snapshot({ state: 'reauthentication-required', reasonCode: 'cli-not-logged-in' })).action).toBe('block');
  expect(decideAuthGate(snapshot({ state: 'provider-unavailable', reasonCode: 'cli-missing' })).action).toBe('block');
  expect(decideAuthGate(snapshot({ state: 'misconfigured', reasonCode: 'precedence-named-conflict' })).action).toBe('block');
  expect(decideAuthGate(snapshot({ state: 'degraded', reasonCode: 'cli-unsupported' })).action).toBe('block');
});

test('inconclusive states allow a bounded bootstrap and configured states do not', () => {
  expect(decideAuthGate(snapshot({ state: 'degraded', reasonCode: 'cli-timeout' }))).toMatchObject({ action: 'allow', bootstrap: 'required' });
  expect(decideAuthGate(snapshot({ state: 'checking', reasonCode: 'not-probed' }))).toMatchObject({ action: 'allow', bootstrap: 'required' });
  expect(decideAuthGate(snapshot({ state: 'configured-unverified', reasonCode: 'cli-logged-in' }))).toMatchObject({ action: 'allow', bootstrap: 'none' });
  expect(decideAuthGate(snapshot({ state: 'verified', reasonCode: 'cli-logged-in', evidence: 'provider-init' }))).toMatchObject({ action: 'allow', bootstrap: 'none' });
  expect(decideAuthGate(snapshot({ provider: 'codex', reasonCode: 'not-probed' }))).toMatchObject({ action: 'allow', bootstrap: 'none' });
});

test('named-credential conflict copy lists env names and never values', () => {
  const blocked = decideAuthGate(
    snapshot({ state: 'misconfigured', reasonCode: 'precedence-named-conflict' }),
    { ANTHROPIC_API_KEY: 'sk-ant-secret-seed-xyz', ANTHROPIC_AUTH_TOKEN: 'secret-token-value' },
  );
  expect(blocked.action).toBe('block');
  if (blocked.action !== 'block') return;
  expect(blocked.userMessage).toContain('ANTHROPIC_AUTH_TOKEN');
  expect(blocked.userMessage).toContain('ANTHROPIC_API_KEY');
  expect(blocked.userMessage).not.toContain('sk-ant-secret-seed-xyz');
  expect(blocked.userMessage).not.toContain('secret-token-value');
});

test('blocked recovery copy never tells Claude to run a Codex command', () => {
  const blocked = decideAuthGate(snapshot({ state: 'reauthentication-required', reasonCode: 'cli-not-logged-in' }));
  expect(blocked.action).toBe('block');
  if (blocked.action !== 'block') return;
  expect(blocked.userMessage).toContain('claude auth login');
  expect(blocked.userMessage.toLowerCase()).not.toContain('codex');
});
