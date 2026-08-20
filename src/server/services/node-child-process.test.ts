import { EventEmitter } from 'node:events';
import { expect, test } from 'bun:test';
import {
  terminateNodeChildProcess,
  waitForNodeChildExit,
  type WaitableNodeChild,
} from './node-child-process';

class FakeChild extends EventEmitter implements WaitableNodeChild {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];
  unrefs = 0;
  onKill?: () => void;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    this.onKill?.();
    return true;
  }

  unref(): void {
    this.unrefs++;
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

const killed = { attempted: true, succeeded: true, exitCode: 0, timedOut: false } as const;

test('node child exit wait handles completion and timeout without leaking listeners', async () => {
  const child = new FakeChild();
  const waiting = waitForNodeChildExit(child, 100);
  child.exit(0);
  expect(await waiting).toBe(true);
  expect(child.listenerCount('exit')).toBe(0);

  const running = new FakeChild();
  expect(await waitForNodeChildExit(running, 5)).toBe(false);
  expect(running.listenerCount('exit')).toBe(0);
});

test('tree termination success is verified against the root exit', async () => {
  const child = new FakeChild();
  const resultPromise = terminateNodeChildProcess(child, { rootExitGraceMs: 100 }, {
    async killTree() {
      queueMicrotask(() => child.exit(137));
      return killed;
    },
  });
  expect(await resultPromise).toMatchObject({
    exited: true,
    directKillAttempted: false,
    detached: false,
  });
  expect(child.kills).toEqual([]);
});

test('hung tree cleanup is bounded and falls back to direct kill', async () => {
  const child = new FakeChild();
  child.onKill = () => queueMicrotask(() => child.exit(137));
  const startedAt = Date.now();
  const result = await terminateNodeChildProcess(child, {
    treeKillTimeoutMs: 5,
    rootExitGraceMs: 0,
    finalExitGraceMs: 100,
  }, {
    killTree: async () => new Promise(() => {}),
  });
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(child.kills).toEqual(['SIGKILL']);
  expect(result).toMatchObject({
    exited: true,
    treeKill: { timedOut: true },
    directKillAttempted: true,
    detached: false,
  });
});

test('an unconfirmed child is detached instead of wedging shutdown', async () => {
  const child = new FakeChild();
  const result = await terminateNodeChildProcess(child, {
    treeKillTimeoutMs: 5,
    rootExitGraceMs: 0,
    finalExitGraceMs: 0,
  }, {
    async killTree() { return { ...killed, succeeded: false }; },
  });
  expect(result).toMatchObject({ exited: false, directKillAttempted: true, detached: true });
  expect(child.kills).toEqual(['SIGKILL']);
  expect(child.unrefs).toBe(1);
});
