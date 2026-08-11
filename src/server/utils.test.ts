import { expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import {
  defaultCliDirs,
  createProcessUnwindSignal,
  killProcessTree,
  waitForOperationOrUnwind,
  type ProcessExitWaitResult,
  type ProcessTerminationDependencies,
  type WaitableKillProcess,
} from './utils';

test('default Windows CLI directories include native user-local installers', () => {
  expect(defaultCliDirs('win32', 'C:\\Users\\test-user')).toEqual([
    'C:\\Users\\test-user\\.local\\bin',
    'C:\\Users\\test-user\\.bun\\bin',
  ]);
});

const neverExits = new Promise<number>(() => {});

interface FakeProcess extends WaitableKillProcess {
  pid: number;
  exitCode: number | null;
  signalCode: number | null;
  killSignals: Array<number | NodeJS.Signals | undefined>;
  unrefCalls: number;
}

function fakeProcess(pid: number): FakeProcess {
  return {
    pid,
    exited: neverExits,
    exitCode: null,
    signalCode: null,
    killSignals: [],
    unrefCalls: 0,
    kill(signal) {
      this.killSignals.push(signal);
    },
    unref() {
      this.unrefCalls++;
    },
  };
}

function exited(exitCode: number): ProcessExitWaitResult {
  return { status: 'exited', exitCode };
}

const timedOut: ProcessExitWaitResult = { status: 'timed-out' };

function terminationHarness(
  root: FakeProcess,
  taskkillOutcomes: ProcessExitWaitResult[],
  rootOutcomes: ProcessExitWaitResult[],
) {
  const killer = fakeProcess(99_999);
  const spawnedPids: number[] = [];
  const waits: Array<{ process: 'taskkill' | 'root'; timeoutMs: number }> = [];
  const deps: ProcessTerminationDependencies = {
    platform: 'win32',
    spawnTaskkill(pid) {
      spawnedPids.push(pid);
      return killer;
    },
    async waitForExit(proc, timeoutMs) {
      const isTaskkill = proc === killer;
      waits.push({ process: isTaskkill ? 'taskkill' : 'root', timeoutMs });
      const outcome = (isTaskkill ? taskkillOutcomes : rootOutcomes).shift();
      if (!outcome) throw new Error(`Missing scripted ${isTaskkill ? 'taskkill' : 'root'} outcome`);
      return outcome;
    },
  };
  return { deps, killer, spawnedPids, waits };
}

test('verified taskkill exit terminates the root without direct fallback', async () => {
  const root = fakeProcess(1234);
  const harness = terminationHarness(root, [exited(0)], [exited(137)]);

  const result = await killProcessTree(
    root as unknown as Subprocess<any, any, any>,
    { taskkillTimeoutMs: 111, rootExitGraceMs: 222, finalExitGraceMs: 333 },
    harness.deps,
  );

  expect(harness.spawnedPids).toEqual([1234]);
  expect(harness.waits).toEqual([
    { process: 'taskkill', timeoutMs: 111 },
    { process: 'root', timeoutMs: 222 },
  ]);
  expect(result).toMatchObject({
    rootExited: true,
    exitCode: 137,
    treeKill: { succeeded: true, exitCode: 0, timedOut: false },
    directKillAttempted: false,
    detached: false,
  });
  expect(root.killSignals).toEqual([]);
  expect(root.unrefCalls).toBe(0);
});

test('nonzero taskkill exit is checked and falls back to direct SIGKILL', async () => {
  const root = fakeProcess(2345);
  const harness = terminationHarness(root, [exited(1)], [timedOut, exited(137)]);

  const result = await killProcessTree(
    root as unknown as Subprocess<any, any, any>,
    { taskkillTimeoutMs: 101, rootExitGraceMs: 202, finalExitGraceMs: 303 },
    harness.deps,
  );

  expect(harness.waits).toEqual([
    { process: 'taskkill', timeoutMs: 101 },
    { process: 'root', timeoutMs: 0 },
    { process: 'root', timeoutMs: 303 },
  ]);
  expect(result).toMatchObject({
    rootExited: true,
    treeKill: {
      succeeded: false,
      exitCode: 1,
      error: 'taskkill exited with code 1',
    },
    directKillAttempted: true,
    detached: false,
  });
  expect(root.killSignals).toEqual(['SIGKILL']);
});

test('hung taskkill is bounded, killed, unrefed, and followed by direct fallback', async () => {
  const root = fakeProcess(3456);
  const harness = terminationHarness(root, [timedOut], [timedOut, exited(137)]);

  const result = await killProcessTree(
    root as unknown as Subprocess<any, any, any>,
    { taskkillTimeoutMs: 75, finalExitGraceMs: 125 },
    harness.deps,
  );

  expect(harness.waits).toEqual([
    { process: 'taskkill', timeoutMs: 75 },
    { process: 'root', timeoutMs: 0 },
    { process: 'root', timeoutMs: 125 },
  ]);
  expect(harness.killer.killSignals).toEqual(['SIGKILL']);
  expect(harness.killer.unrefCalls).toBe(1);
  expect(root.killSignals).toEqual(['SIGKILL']);
  expect(result.treeKill.timedOut).toBe(true);
  expect(result.rootExited).toBe(true);
});

test('unresolved root is detached after the bounded final wait', async () => {
  const root = fakeProcess(4567);
  const harness = terminationHarness(root, [exited(0)], [timedOut, timedOut]);

  const result = await killProcessTree(
    root as unknown as Subprocess<any, any, any>,
    { rootExitGraceMs: 400, finalExitGraceMs: 500 },
    harness.deps,
  );

  expect(harness.waits).toEqual([
    { process: 'taskkill', timeoutMs: 1_500 },
    { process: 'root', timeoutMs: 400 },
    { process: 'root', timeoutMs: 500 },
  ]);
  expect(root.killSignals).toEqual(['SIGKILL']);
  expect(root.unrefCalls).toBe(1);
  expect(result).toMatchObject({
    rootExited: false,
    directKillAttempted: true,
    detached: true,
  });
});

test('an already-exited root is not sent to taskkill', async () => {
  const root = fakeProcess(5678);
  root.exitCode = 0;
  const harness = terminationHarness(root, [], []);

  const result = await killProcessTree(
    root as unknown as Subprocess<any, any, any>,
    {},
    harness.deps,
  );

  expect(harness.spawnedPids).toEqual([]);
  expect(harness.waits).toEqual([]);
  expect(result).toMatchObject({
    rootExited: true,
    exitCode: 0,
    directKillAttempted: false,
    detached: false,
  });
});

test('a forced unwind releases an adapter from an operation that never resolves', async () => {
  const signal = createProcessUnwindSignal();
  const pending = waitForOperationOrUnwind(new Promise<string>(() => {}), signal);

  signal.trigger();
  signal.trigger();

  expect(await pending).toEqual({ status: 'unwound' });
  expect(signal.isTriggered()).toBeTrue();
});

test('a completed operation wins when no forced unwind was requested', async () => {
  const signal = createProcessUnwindSignal();

  expect(await waitForOperationOrUnwind(Promise.resolve('complete'), signal)).toEqual({
    status: 'completed',
    value: 'complete',
  });
});
