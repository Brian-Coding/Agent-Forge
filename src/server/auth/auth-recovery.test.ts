import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeAuthProbe, createCodexAuthProbe } from './provider-auth-probe';
import { createProviderAuthCoordinator } from './provider-auth-coordinator';
import { createAuthRecoveryStore } from './auth-recovery';

test('recovery state stays linked to the accepted prompt and requires confirmation after side effects', () => {
  const store = createAuthRecoveryStore({ now: () => 10 });
  const incident = store.record({
    agentId: 'a1',
    provider: 'claude',
    messageId: 'msg-1',
    reasonCode: 'cli-not-logged-in',
    state: 'reauthentication-required',
    retrySafe: false,
    sideEffectRisk: true,
    automaticRetryUsed: false,
  });
  expect(incident?.messageId).toBe('msg-1');
  expect(store.snapshot().incidents).toHaveLength(1);
  expect(store.canRetry('a1', incident!.incidentId, false)).toMatchObject({
    ok: false,
    reasonCode: 'side-effect-review-required',
  });
  expect(store.canRetry('a1', incident!.incidentId, true)).toMatchObject({ ok: true });
  store.resolveAgent('a1');
  expect(store.snapshot().incidents).toHaveLength(0);
  expect(store.canRetry('a1', incident!.incidentId, true).ok).toBe(false);
});

test('check again does not start a turn and a Claude incident cannot mention Codex', async () => {
  const previous = (globalThis as any).__providerAuthCoordinator;
  (globalThis as any).__providerAuthCoordinator = createProviderAuthCoordinator({
    probes: {
      claude: createClaudeAuthProbe(async () => ({
        exitCode: 0,
        stdout: '{"loggedIn":true,"authMethod":"oauth"}\n',
        stderr: '',
        timedOut: false,
      })),
      codex: createCodexAuthProbe(),
    },
    env: {},
  });
  try {
    const store = createAuthRecoveryStore({ now: () => 20 });
    store.record({
      agentId: 'a1',
      provider: 'claude',
      messageId: 'msg-1',
      reasonCode: 'cli-not-logged-in',
      state: 'reauthentication-required',
      retrySafe: true,
      sideEffectRisk: false,
      automaticRetryUsed: false,
    });
    const snapshot = await store.checkAgain('a1', 'claude');
    expect(snapshot.state).toBe('configured-unverified');
    const incident = store.openForAgent('a1')[0];
    expect(incident?.userMessage).toContain('Retry the preserved prompt');
    expect(incident?.userMessage.toLowerCase()).not.toContain('codex');
    expect(JSON.stringify(store.snapshot())).not.toContain('sk-ant-');
  } finally {
    (globalThis as any).__providerAuthCoordinator = previous;
  }
});

test('recovery modules own no server lifecycle or credential files', () => {
  for (const file of ['recovery-copy.ts', 'auth-recovery.ts', 'auth-retry-policy.ts']) {
    const source = readFileSync(join(import.meta.dir, file), 'utf8');
    expect(source).not.toMatch(/shutdown|process-lock|killProcessTree|credentials\.json/);
  }
});
