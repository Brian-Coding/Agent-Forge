import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('demo startup, model refresh, limits refresh and auth checks avoid provider IO', async () => {
  // Process isolation keeps demo overrides out of other service tests.
  const script = `
    import { installOfflineDemoServices } from './scripts/demo/offline-services';
    import { handleGetModels } from './src/server/routes/models.routes';
    import { captureRuntimeStartup, getRuntimeHealth } from './src/server/services/runtime-truth';
    import { limitsService } from './src/server/services/limits.service';
    import { currentAuthCoordinator } from './src/server/auth/provider-auth-coordinator';
    const originalSpawn = Bun.spawn;
    const unexpected = [];
    Bun.spawn = (args, options) => {
      if (args[0] !== 'git') { unexpected.push('provider process'); throw new Error('Provider IO forbidden'); }
      return originalSpawn(args, options);
    };
    globalThis.fetch = async () => { unexpected.push('network'); throw new Error('Network forbidden'); };
    installOfflineDemoServices();
    await captureRuntimeStartup();
    const health = await getRuntimeHealth();
    const models = await (await handleGetModels(new Request('http://127.0.0.1/api/models?refresh=1'))).json();
    const limits = await limitsService.refresh(false, { force: true });
    await currentAuthCoordinator().probe('claude');
    await currentAuthCoordinator().probe('codex');
    if (unexpected.length || models.error || !models.providers.codex || health.runtime.providers.some(p => p.available) || limits.providers.codex.status !== 'unavailable') throw new Error('Demo escaped static services');
  `;
  const proc = Bun.spawn([process.execPath, '-e', script], { cwd: resolve(import.meta.dir, '../..'), stdout: 'ignore', stderr: 'pipe' });
  const errors = await new Response(proc.stderr).text();
  expect(await proc.exited, errors).toBe(0);
});
