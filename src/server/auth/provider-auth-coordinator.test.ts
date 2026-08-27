import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { healthContainsSecretLikeValue } from '../../shared/runtime-health';
import { classifyClaudeAuthOutput } from './classify-claude-auth';
import { createClaudeAuthProbe, createCodexAuthProbe } from './provider-auth-probe';
import { createProviderAuthCoordinator } from './provider-auth-coordinator';

test('ten concurrent probes collapse to one bounded Claude status run', async () => {
  let calls = 0;
  const coordinator = createProviderAuthCoordinator({
    now: () => 1_000,
    probes: {
      claude: createClaudeAuthProbe(async () => {
        calls += 1;
        await Bun.sleep(20);
        return { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"oauth"}\n', stderr: '', timedOut: false };
      }),
      codex: createCodexAuthProbe(),
    },
    env: { PATH: 'C:\\bin' },
  });

  const results = await Promise.all(Array.from({ length: 10 }, () => coordinator.probe('claude', '2.1.241')));
  expect(calls).toBe(1);
  expect(new Set(results.map(result => result.reasonCode))).toEqual(new Set(['cli-logged-in']));
  expect(results.every(result => result.state === 'configured-unverified')).toBe(true);
});

test('a timed-out probe stays degraded and never looks authenticated', async () => {
  const coordinator = createProviderAuthCoordinator({
    probes: {
      claude: createClaudeAuthProbe(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })),
      codex: createCodexAuthProbe(),
    },
    env: {},
  });
  const snapshot = await coordinator.probe('claude');
  expect(snapshot).toMatchObject({ state: 'degraded', reasonCode: 'cli-timeout' });
});

test('cache invalidation and env-generation changes force a new probe', async () => {
  let calls = 0;
  let loggedIn = true;
  const env: Record<string, string | undefined> = { PATH: 'C:\\bin' };
  const coordinator = createProviderAuthCoordinator({
    cacheTtlMs: 30_000,
    now: () => 5_000,
    env,
    probes: {
      claude: createClaudeAuthProbe(async () => {
        calls += 1;
        return {
          exitCode: loggedIn ? 0 : 1,
          stdout: JSON.stringify({ loggedIn, authMethod: loggedIn ? 'oauth' : 'none' }) + '\n',
          stderr: '',
          timedOut: false,
        };
      }),
      codex: createCodexAuthProbe(),
    },
  });

  expect((await coordinator.probe('claude')).reasonCode).toBe('cli-logged-in');
  loggedIn = false;
  expect((await coordinator.probe('claude')).reasonCode).toBe('cli-logged-in');
  coordinator.invalidate('claude');
  expect((await coordinator.probe('claude')).reasonCode).toBe('cli-not-logged-in');
  env.ANTHROPIC_API_KEY = 'sk-ant-secret-seed-xyz';
  expect((await coordinator.probe('claude')).reasonCode).toBe('named-credential-present');
  expect(calls).toBe(3);
});

test('shadow comparison is redacted and does not treat inconclusive as a false logout', () => {
  const lines: string[] = [];
  const coordinator = createProviderAuthCoordinator({
    now: () => 1_000,
    log: line => lines.push(line),
    env: { ANTHROPIC_API_KEY: 'sk-ant-secret-seed-xyz' },
  });
  coordinator.observeCollected('claude', {
    kind: 'auth-status',
    timedOut: true,
    env: { ANTHROPIC_API_KEY: 'sk-ant-secret-seed-xyz' },
  }, { outcome: 'allow', class: 'inconclusive-allow' });
  const comparison = coordinator.comparisons()[0];
  expect(comparison?.agree).toBe(true);
  expect(comparison?.classifierState).toBe('configured-unverified');
  expect(lines.join('\n')).not.toContain('sk-ant-secret-seed-xyz');
  expect(healthContainsSecretLikeValue(coordinator.getSnapshot('claude'))).toBe(false);
});

test('classifier never reads the credential file and coordinator source owns no server lifecycle', () => {
  expect(readFileSync(join(import.meta.dir, 'classify-claude-auth.ts'), 'utf8')).not.toContain('credentials');
  expect(readFileSync(join(import.meta.dir, 'provider-auth-coordinator.ts'), 'utf8')).not.toMatch(/shutdown|process-lock|killProcessTree|credentials\.json/);
  expect(readFileSync(join(import.meta.dir, 'provider-auth-probe.ts'), 'utf8')).not.toContain('credentials.json');
});

test('named env conflict and unsupported CLI stay typed without leaking values', () => {
  expect(classifyClaudeAuthOutput({
    kind: 'auth-status',
    exitCode: 0,
    stdout: '{"loggedIn":true,"authMethod":"oauth"}\n',
    env: { ANTHROPIC_AUTH_TOKEN: 'secret-a', ANTHROPIC_API_KEY: 'secret-b' },
  })).toMatchObject({
    state: 'misconfigured',
    reasonCode: 'precedence-named-conflict',
    credentialMode: 'auth-token',
  });
  expect(classifyClaudeAuthOutput({
    kind: 'auth-status',
    exitCode: 0,
    stdout: '{"loggedIn":true,"authMethod":"oauth"}\n',
    cliVersion: '2.1.100',
  })).toMatchObject({
    state: 'degraded',
    reasonCode: 'cli-unsupported',
    recoveryAction: 'update-cli',
  });
});
