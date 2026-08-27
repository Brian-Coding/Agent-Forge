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
  expect(readFileSync(join(import.meta.dir, 'auth-gate.ts'), 'utf8')).not.toMatch(/shutdown|process-lock|killProcessTree|credentials\.json/);
  const claudeAdapter = readFileSync(join(import.meta.dir, '../agents/adapters/claude.ts'), 'utf8');
  expect(claudeAdapter).not.toContain('getClaudeAuthError');
  expect(claudeAdapter).not.toContain('readClaudeCredentialState');
});

test('ten Claude starts share one probe and do not hold the Codex bootstrap lock', async () => {
  let claudeCalls = 0;
  const coordinator = createProviderAuthCoordinator({
    probes: {
      claude: createClaudeAuthProbe(async () => {
        claudeCalls += 1;
        await Bun.sleep(15);
        return { exitCode: 0, stdout: '{"loggedIn":true,"authMethod":"oauth"}\n', stderr: '', timedOut: false };
      }),
      codex: createCodexAuthProbe(),
    },
    env: {},
  });

  const [codexPermit, ...claudePermits] = await Promise.all([
    coordinator.prepareStart('codex'),
    ...Array.from({ length: 10 }, () => coordinator.prepareStart('claude')),
  ]);
  expect(codexPermit.action).toBe('allow');
  expect(codexPermit.needsInitHold).toBe(false);
  expect(claudeCalls).toBe(1);
  expect(claudePermits.every(permit => permit.action === 'allow' && permit.bootstrap === 'none')).toBe(true);
  for (const permit of [codexPermit, ...claudePermits]) permit.release();
});

test('an inconclusive Claude bootstrap holds only Claude and a probe timeout cannot stick the mutex', async () => {
  let claudeCalls = 0;
  let releaseProbe!: () => void;
  const probeHold = new Promise<void>(resolve => { releaseProbe = resolve; });
  const coordinator = createProviderAuthCoordinator({
    initDeadlineMs: 30_000,
    probes: {
      claude: createClaudeAuthProbe(async () => {
        claudeCalls += 1;
        await probeHold;
        return { exitCode: null, stdout: '', stderr: '', timedOut: true };
      }),
      codex: createCodexAuthProbe(),
    },
    env: {},
  });

  const first = coordinator.prepareStart('claude');
  await Bun.sleep(10);
  const second = coordinator.prepareStart('claude');
  const codex = await coordinator.prepareStart('codex');
  expect(codex.action).toBe('allow');
  expect(codex.needsInitHold).toBe(false);
  codex.release();

  releaseProbe();
  const firstPermit = await first;
  expect(claudeCalls).toBe(1);
  expect(firstPermit).toMatchObject({ action: 'allow', bootstrap: 'required', needsInitHold: true });

  let secondReady = false;
  void second.then(() => { secondReady = true; });
  await Bun.sleep(20);
  expect(secondReady).toBe(false);

  firstPermit.release();
  const secondPermit = await second;
  expect(claudeCalls).toBe(1);
  expect(secondPermit.needsInitHold).toBe(true);
  secondPermit.release();
});

test('a skipped Claude check and a thrown probe cannot wedge later starts', async () => {
  let calls = 0;
  const skipCoordinator = createProviderAuthCoordinator({
    probes: {
      claude: createClaudeAuthProbe(async () => {
        calls += 1;
        return { exitCode: 1, stdout: '{"loggedIn":false,"authMethod":"none"}\n', stderr: '', timedOut: false };
      }),
      codex: createCodexAuthProbe(),
    },
    env: { AGENT_FORGE_SKIP_CLAUDE_AUTH_CHECK: '1' },
  });
  const skipped = await skipCoordinator.prepareStart('claude');
  expect(skipped).toMatchObject({ action: 'allow', bootstrap: 'none' });
  expect(calls).toBe(0);
  skipped.release();

  let attempts = 0;
  const throwing = createProviderAuthCoordinator({
    probes: {
      claude: createClaudeAuthProbe(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('probe exploded');
        return { exitCode: null, stdout: '', stderr: '', timedOut: true };
      }),
      codex: createCodexAuthProbe(),
    },
    env: {},
  });
  await expect(throwing.prepareStart('claude')).rejects.toThrow('probe exploded');
  const recovered = await throwing.prepareStart('claude');
  expect(recovered).toMatchObject({ action: 'allow', bootstrap: 'required' });
  recovered.release();
});

test('the bootstrap watchdog releases a forgotten hold', async () => {
  const coordinator = createProviderAuthCoordinator({
    initDeadlineMs: 25,
    probes: {
      claude: createClaudeAuthProbe(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })),
      codex: createCodexAuthProbe(),
    },
    env: {},
  });
  const held = await coordinator.prepareStart('claude');
  expect(held.needsInitHold).toBe(true);
  const next = await coordinator.prepareStart('claude');
  expect(next.action).toBe('allow');
  held.release();
  next.release();
});

test('a blocking Claude snapshot does not change Codex and probe failure cannot stick the mutex', async () => {
  const coordinator = createProviderAuthCoordinator({
    probes: {
      claude: createClaudeAuthProbe(async () => ({
        exitCode: 1,
        stdout: '{"loggedIn":false,"authMethod":"none"}\n',
        stderr: '',
        timedOut: false,
      })),
      codex: createCodexAuthProbe(),
    },
    env: {},
  });
  const blocked = await coordinator.prepareStart('claude');
  expect(blocked.action).toBe('block');
  blocked.release();
  const codex = await coordinator.prepareStart('codex');
  expect(codex.action).toBe('allow');
  codex.release();
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
