import { expect, test } from 'bun:test';
import { healthContainsSecretLikeValue } from '../../shared/runtime-health';
import { createClaudeAuthProbe, createCodexAuthProbe } from '../auth/provider-auth-probe';
import { createProviderAuthCoordinator } from '../auth/provider-auth-coordinator';
import { createRuntimeTruth } from '../services/runtime-truth';
import { handleRuntimeHealth } from './health.routes';

test('health route returns classified auth snapshots without leaking secrets', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  const previousTruth = (globalThis as any).__runtimeTruth;
  const previousAuth = (globalThis as any).__providerAuthCoordinator;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-seed-xyz';
  try {
    (globalThis as any).__providerAuthCoordinator = createProviderAuthCoordinator({
      env: { ANTHROPIC_API_KEY: 'sk-ant-secret-seed-xyz' },
      probes: {
        claude: createClaudeAuthProbe(async () => ({
          exitCode: 1,
          stdout: '{"loggedIn":false,"authMethod":"none"}\n',
          stderr: '',
          timedOut: false,
        })),
        codex: createCodexAuthProbe(),
      },
    });
    const isolated = createRuntimeTruth({
      serverSessionId: 'route-session',
      bunVersion: '1.3.14',
      readGitIdentity: () => ({ commit: 'deadbeef', dirty: false }),
      probeProviders: () => ([
        { provider: 'claude', cliName: 'claude', available: true, cliVersion: '2.1.241' },
        { provider: 'codex', cliName: 'codex', available: false },
      ]),
    });
    await isolated.captureStartup();
    (globalThis as any).__runtimeTruth = isolated;

    const response = await handleRuntimeHealth();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.runtime.serverSessionId).toBe('route-session');
    expect(body.auth.find((snapshot: any) => snapshot.provider === 'claude')).toMatchObject({
      state: 'configured-unverified',
      reasonCode: 'named-credential-present',
    });
    expect(body.auth.find((snapshot: any) => snapshot.provider === 'codex').reasonCode).toBe('not-probed');
    expect(JSON.stringify(body)).not.toContain('sk-ant-secret-seed-xyz');
    expect(healthContainsSecretLikeValue(body)).toBe(false);
  } finally {
    (globalThis as any).__runtimeTruth = previousTruth;
    (globalThis as any).__providerAuthCoordinator = previousAuth;
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});
