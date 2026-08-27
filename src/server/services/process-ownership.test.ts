import { expect, test } from 'bun:test';
import { createFakeProcessProbe, createProcessProbe } from '../platform/process-probe';
import {
  createOwnershipSession,
  decideOwnership,
  decidePriorServerHandoff,
  hashOwnershipNonce,
  recordFromProbe,
  START_TIME_MATCH_TOLERANCE_MS,
  terminateIfOwned,
} from './process-ownership';

const start = 1_700_000_000_000;

function ownedRecord(overrides: Partial<Parameters<typeof recordFromProbe>[2]> & { kind?: 'claude' | 'codex' | 'server' } = {}) {
  const session = createOwnershipSession('instance-a');
  return recordFromProbe(session, overrides.kind ?? 'claude', {
    pid: 4242,
    name: 'claude',
    startTimeMs: start,
    ...overrides,
  });
}

test('A0 baseline records runtime versions used by process-ownership fixtures', () => {
  expect(typeof process.versions.bun).toBe('string');
  expect(['win32', 'darwin', 'linux']).toContain(process.platform);
  expect(START_TIME_MATCH_TOLERANCE_MS).toBe(15_000);
});

test('a PID or executable name alone never authorizes termination', () => {
  const record = ownedRecord();
  expect(decideOwnership(record, { status: 'partial', identity: { pid: 4242 } })).toEqual({
    terminate: false,
    reason: 'facts-unavailable',
  });
  expect(decideOwnership(record, { status: 'matched', identity: { pid: 4242, name: 'claude' } })).toEqual({
    terminate: false,
    reason: 'facts-unavailable',
  });
  expect(decideOwnership({ processId: 4242, legacy: true }, {
    status: 'matched',
    identity: { pid: 4242, name: 'claude', startTimeMs: start },
  })).toEqual({ terminate: false, reason: 'legacy-unverified' });
});

test('executable matches but start time differs', () => {
  const record = ownedRecord();
  expect(decideOwnership(record, {
    status: 'matched',
    identity: { pid: 4242, name: 'claude', startTimeMs: start + START_TIME_MATCH_TOLERANCE_MS + 1 },
  })).toEqual({ terminate: false, reason: 'start-time-mismatch' });
});

test('start time matches but ownership instance or nonce differs', () => {
  const record = ownedRecord();
  const probe = { status: 'matched' as const, identity: { pid: 4242, name: 'claude', startTimeMs: start } };
  expect(decideOwnership(record, probe, { expectedInstanceId: 'other-instance' })).toEqual({
    terminate: false,
    reason: 'instance-mismatch',
  });
  expect(decideOwnership(record, probe, { expectedNonceHash: hashOwnershipNonce('other-nonce') })).toEqual({
    terminate: false,
    reason: 'nonce-mismatch',
  });
});

test('a stored PID reused by a different Bun process is not owned', () => {
  const record = ownedRecord({ name: 'claude' });
  expect(decideOwnership(record, {
    status: 'matched',
    identity: { pid: 4242, name: 'bun', startTimeMs: start },
  })).toEqual({ terminate: false, reason: 'pid-reused' });
});

test('a full identity match authorizes termination', () => {
  const record = ownedRecord();
  expect(decideOwnership(record, {
    status: 'matched',
    identity: { pid: 4242, name: 'claude.exe', startTimeMs: start + 12_000 },
  })).toEqual({ terminate: true, reason: 'owned-match' });
});

test('denied, timeout, and ambiguous probes fail closed', () => {
  const record = ownedRecord();
  expect(decideOwnership(record, { status: 'denied' }).reason).toBe('probe-denied');
  expect(decideOwnership(record, { status: 'timeout' }).reason).toBe('probe-timeout');
  expect(decideOwnership(record, { status: 'ambiguous' }).reason).toBe('probe-ambiguous');
  expect(decideOwnership(record, { status: 'missing' }).reason).toBe('missing');
});

test('prior-server handoff requires Bun plus a start time near the lock', () => {
  const lockStartedAt = new Date(start).toISOString();
  expect(decidePriorServerHandoff(lockStartedAt, {
    status: 'matched',
    identity: { pid: 77, name: 'bun', startTimeMs: start + 1_000 },
  })).toEqual({ terminate: true, reason: 'owned-match' });
  expect(decidePriorServerHandoff(lockStartedAt, {
    status: 'matched',
    identity: { pid: 77, name: 'chrome', startTimeMs: start },
  }).reason).toBe('pid-reused');
  expect(decidePriorServerHandoff(lockStartedAt, {
    status: 'matched',
    identity: { pid: 77, name: 'bun', startTimeMs: start + 20_000 },
  }).reason).toBe('start-time-mismatch');
  expect(decidePriorServerHandoff(lockStartedAt, {
    status: 'matched',
    identity: { pid: 77, name: 'bun' },
  }).reason).toBe('facts-unavailable');
});

test('terminateIfOwned re-probes and skips a process that vanished between checks', async () => {
  const record = ownedRecord();
  const results = [
    { status: 'matched' as const, identity: { pid: 4242, name: 'claude', startTimeMs: start } },
    { status: 'missing' as const },
  ];
  const killed: number[] = [];
  const outcome = await terminateIfOwned({
    record,
    probe: {
      async probe() {
        return results.shift() ?? { status: 'missing' };
      },
      async probeMany() { return new Map(); },
    },
    killTree: async pid => {
      killed.push(pid);
      return { attempted: true, succeeded: true, exitCode: 0, timedOut: false };
    },
  });
  expect(outcome).toEqual({ decision: { terminate: false, reason: 'missing' }, killed: false });
  expect(killed).toEqual([]);
});

test('terminateIfOwned kills only after two matching probes', async () => {
  const record = ownedRecord();
  const killed: number[] = [];
  const outcome = await terminateIfOwned({
    record,
    probe: createFakeProcessProbe(new Map([
      [4242, { status: 'matched', identity: { pid: 4242, name: 'claude', startTimeMs: start } }],
    ])),
    killTree: async pid => {
      killed.push(pid);
      return { attempted: true, succeeded: true, exitCode: 0, timedOut: false };
    },
  });
  expect(outcome.killed).toBe(true);
  expect(outcome.decision.reason).toBe('owned-match');
  expect(killed).toEqual([4242]);
});

test('createProcessProbe treats name-only facts as partial and maps probe failures', async () => {
  const nameOnly = createProcessProbe({
    lookup: async pid => ({ pid, name: 'bun' }),
  });
  expect(await nameOnly.probe(9)).toEqual({
    status: 'partial',
    identity: { pid: 9, name: 'bun' },
  });

  const denied = createProcessProbe({
    lookup: async () => { throw new Error('EACCES permission denied'); },
  });
  expect((await denied.probe(9)).status).toBe('denied');

  const timedOut = createProcessProbe({
    lookup: async () => { throw new Error('probe timed out'); },
  });
  expect((await timedOut.probe(9)).status).toBe('timeout');

  const locale = createProcessProbe({
    lookup: async pid => ({ pid, name: 'bun.exe', startTimeMs: Number.NaN }),
  });
  expect((await locale.probe(9)).status).toBe('partial');
});
