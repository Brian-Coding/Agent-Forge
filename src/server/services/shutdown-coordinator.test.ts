import { expect, test } from 'bun:test';
import { createShutdownCoordinator, type ShutdownDependencies } from './shutdown-coordinator';

function dependencies(
  events: string[],
  overrides: Partial<ShutdownDependencies> = {},
): ShutdownDependencies {
  return {
    stopIntake: () => { events.push('intake'); },
    stopWork: () => { events.push('work'); },
    forceStopWork: () => { events.push('force'); },
    persistData: () => { events.push('data'); },
    persistPids: () => { events.push('pids'); },
    releaseLock: () => { events.push('lock'); },
    exit: code => { events.push(`exit:${code}`); },
    log: () => {},
    ...overrides,
  };
}

test('concurrent and repeated shutdown requests execute every stage exactly once', async () => {
  const events: string[] = [];
  const shutdown = createShutdownCoordinator(dependencies(events));
  const first = shutdown({ reason: 'SIGINT' });
  const second = shutdown({ reason: 'SIGTERM' });
  expect(second).toBe(first);
  await Promise.all([first, second, shutdown()]);
  expect(events).toEqual(['intake', 'work', 'data', 'pids', 'lock', 'exit:0']);
});

test('a hung graceful cleanup triggers bounded force cleanup and still persists', async () => {
  const events: string[] = [];
  const shutdown = createShutdownCoordinator(dependencies(events, {
    stopWork: () => { events.push('work'); return new Promise<void>(() => {}); },
    forceStopWork: () => { events.push('force'); return new Promise<void>(() => {}); },
  }), { stopWorkMs: 10, forceStopWorkMs: 10 });
  const startedAt = Date.now();
  await shutdown();
  // Logical deadlines are 10ms each; allow generous host scheduling jitter
  // so this remains a reliability test instead of becoming a timing flake.
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(events).toEqual(['intake', 'work', 'force', 'data', 'pids', 'lock', 'exit:0']);
});

test('stage failures do not skip later cleanup and a fatal request exits nonzero', async () => {
  const events: string[] = [];
  const logs: string[] = [];
  const shutdown = createShutdownCoordinator(dependencies(events, {
    stopIntake: () => { events.push('intake'); throw new Error('socket failure'); },
    stopWork: () => { events.push('work'); throw new Error('worker failure'); },
    persistData: () => { events.push('data'); throw new Error('disk failure'); },
    persistPids: () => { events.push('pids'); throw new Error('pid failure'); },
    releaseLock: () => { events.push('lock'); throw new Error('lock failure'); },
    log: (_level, message) => { logs.push(message); },
  }));
  await shutdown({ exitCode: 1, reason: 'uncaught exception' });
  expect(events).toEqual(['intake', 'work', 'force', 'data', 'pids', 'lock', 'exit:1']);
  expect(logs.filter(message => message.includes('failed')).length).toBe(5);
});

test('a fatal request arriving during graceful shutdown upgrades the final exit code', async () => {
  const events: string[] = [];
  let releaseWork!: () => void;
  const workGate = new Promise<void>(resolve => { releaseWork = resolve; });
  const shutdown = createShutdownCoordinator(dependencies(events, {
    stopWork: async () => { events.push('work'); await workGate; },
  }));
  const normal = shutdown({ exitCode: 0 });
  await Promise.resolve();
  const fatal = shutdown({ exitCode: 7 });
  expect(fatal).toBe(normal);
  releaseWork();
  await normal;
  expect(events.at(-1)).toBe('exit:7');
});

test('an explicit force request is coalesced and never duplicates cleanup', async () => {
  const events: string[] = [];
  let releaseWork!: () => void;
  const workGate = new Promise<void>(resolve => { releaseWork = resolve; });
  const shutdown = createShutdownCoordinator(dependencies(events, {
    stopWork: async () => { events.push('work'); await workGate; },
  }));
  const pending = shutdown();
  await Promise.resolve();
  shutdown({ force: true });
  shutdown({ force: true });
  releaseWork();
  await pending;
  expect(events.filter(event => event === 'force')).toHaveLength(1);
  expect(events.filter(event => event === 'exit:0')).toHaveLength(1);
});
