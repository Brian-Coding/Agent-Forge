import { expect, test } from 'bun:test';
import { createFakeProcessProbe } from './platform/process-probe';
import { inspectExistingServerLock, reportOccupiedPorts } from './process-startup';

const start = 1_700_000_000_000;
const startedAt = new Date(start).toISOString();

test('graceful handoff replaces the lock only after the prior server exits', async () => {
  const requested: number[] = [];
  const decision = await inspectExistingServerLock({ pid: 88, startedAt }, {
    probe: createFakeProcessProbe(new Map([
      [88, { status: 'matched', identity: { pid: 88, name: 'bun', startTimeMs: start + 500 } }],
    ])),
    isImmediateAncestor: () => false,
    requestGracefulExit(pid) { requested.push(pid); },
    waitForExit: async () => true,
  });
  expect(requested).toEqual([88]);
  expect(decision.action).toBe('replace');
});

test('graceful handoff timeout refuses unsafe force-kill', async () => {
  const requested: number[] = [];
  const decision = await inspectExistingServerLock({ pid: 88, startedAt }, {
    probe: createFakeProcessProbe(new Map([
      [88, { status: 'matched', identity: { pid: 88, name: 'bun', startTimeMs: start } }],
    ])),
    isImmediateAncestor: () => false,
    requestGracefulExit(pid) { requested.push(pid); },
    waitForExit: async () => false,
  });
  expect(requested).toEqual([88]);
  expect(decision.action).toBe('refuse');
  expect(decision.reason).toContain('Unsafe force-kill is disabled');
});

test('a reused PID that is no longer Bun replaces the lock without a kill request', async () => {
  const requested: number[] = [];
  const decision = await inspectExistingServerLock({ pid: 88, startedAt }, {
    probe: createFakeProcessProbe(new Map([
      [88, { status: 'matched', identity: { pid: 88, name: 'chrome', startTimeMs: start } }],
    ])),
    isImmediateAncestor: () => false,
    requestGracefulExit(pid) { requested.push(pid); },
    waitForExit: async () => {
      throw new Error('waitForExit should not run');
    },
  });
  expect(requested).toEqual([]);
  expect(decision.action).toBe('replace');
});

test('a live Bun with unproven start time fails closed', async () => {
  const requested: number[] = [];
  const decision = await inspectExistingServerLock({ pid: 88, startedAt }, {
    probe: createFakeProcessProbe(new Map([
      [88, { status: 'partial', identity: { pid: 88, name: 'bun' } }],
    ])),
    isImmediateAncestor: () => false,
    requestGracefulExit(pid) { requested.push(pid); },
    waitForExit: async () => false,
  });
  expect(requested).toEqual([]);
  expect(decision.action).toBe('refuse');
  expect(decision.reason).toContain('ownership is facts-unavailable');
});

test('an ancestor lock is refused without probing', async () => {
  let probed = false;
  const decision = await inspectExistingServerLock({ pid: 11, startedAt }, {
    probe: {
      async probe() {
        probed = true;
        return { status: 'matched', identity: { pid: 11, name: 'bun', startTimeMs: start } };
      },
      async probeMany() { return new Map(); },
    },
    isImmediateAncestor: pid => pid === 11,
    requestGracefulExit() { throw new Error('should not kill ancestor'); },
    waitForExit: async () => false,
  });
  expect(probed).toBe(false);
  expect(decision.action).toBe('refuse');
  expect(decision.reason).toContain('ancestor');
});

test('a missing PID replaces a stale lock', async () => {
  const decision = await inspectExistingServerLock({ pid: 88, startedAt }, {
    probe: createFakeProcessProbe(),
    isImmediateAncestor: () => false,
    requestGracefulExit() { throw new Error('missing PID must not be killed'); },
    waitForExit: async () => false,
  });
  expect(decision.action).toBe('replace');
});

test('occupied-port reporting lists listeners and never implies a kill set', () => {
  const netstat = [
    '  TCP    127.0.0.1:3333         0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:3334         0.0.0.0:0              LISTENING       99',
    '  TCP    127.0.0.1:4000         0.0.0.0:0              LISTENING       7',
    '  TCP    127.0.0.1:3333         0.0.0.0:0              ESTABLISHED     8',
  ].join('\n');
  expect(reportOccupiedPorts(netstat, 3333, 3340, 99)).toEqual([4242]);
});
