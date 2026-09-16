import { expect, test } from 'bun:test';
import { launcherIsGone, monitorLauncher } from './launch-lifecycle';

test('missing or reused parent triggers shutdown, unavailable facts do not', () => {
  const initial = { status: 'matched' as const, identity: { pid: 42, startTimeMs: 100 } };
  expect(launcherIsGone(initial, { status: 'missing' })).toBe(true);
  expect(launcherIsGone(initial, { status: 'matched', identity: { pid: 42, startTimeMs: 101 } })).toBe(true);
  expect(launcherIsGone(initial, initial)).toBe(false);
  expect(launcherIsGone(initial, { status: 'denied' })).toBe(false);
});

test('restart request shuts down exactly once', async () => {
  let calls = 0;
  const cancel = monitorLauncher({
    probe: async () => ({ status: 'partial', identity: { pid: 42 } }),
    stopRequested: () => true,
    shutdown: () => { calls++; },
    intervalMs: 1,
  });
  await Bun.sleep(20);
  cancel();
  expect(calls).toBe(1);
});
