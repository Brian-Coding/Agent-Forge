import { expect, test } from 'bun:test';
import { healthContainsSecretLikeValue } from '../../shared/runtime-health';
import { createRuntimeTruth } from '../services/runtime-truth';
import { handleRuntimeHealth } from './health.routes';

test('health route returns the runtime snapshot without probing auth or leaking secrets', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  const previousTruth = (globalThis as any).__runtimeTruth;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-seed-xyz';
  try {
    const isolated = createRuntimeTruth({
      serverSessionId: 'route-session',
      bunVersion: '1.3.14',
      readGitIdentity: () => ({ commit: 'deadbeef', dirty: false }),
      probeProviders: () => ([
        { provider: 'claude', cliName: 'claude', available: false },
        { provider: 'codex', cliName: 'codex', available: false },
      ]),
    });
    await isolated.captureStartup();
    (globalThis as any).__runtimeTruth = isolated;

    const response = await handleRuntimeHealth();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.runtime.serverSessionId).toBe('route-session');
    expect(body.runtime.bunVersion).toBe('1.3.14');
    expect(['current', 'restart-required', 'unknown']).toContain(body.runtime.drift);
    expect(body.auth.every((snapshot: any) => snapshot.reasonCode === 'not-probed')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-ant-secret-seed-xyz');
    expect(healthContainsSecretLikeValue(body)).toBe(false);
  } finally {
    (globalThis as any).__runtimeTruth = previousTruth;
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});
