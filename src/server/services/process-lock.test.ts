import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireProcessLockFile,
  ProcessLockHeldError,
  processExists,
  releaseProcessLockFile,
} from './process-lock';

const roots: string[] = [];

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'af-process-lock-'));
  roots.push(root);
  return join(root, 'agent-forge.lock');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('exclusive acquisition permits exactly one simultaneous owner', async () => {
  const path = lockPath();
  const attempts = Array.from({ length: 12 }, (_, index) => acquireProcessLockFile({
    path,
    pid: 10_000 + index,
    inspectExisting: owner => ({ action: 'refuse', reason: `held by ${owner.pid}` }),
  }));
  const results = await Promise.allSettled(attempts);
  const acquired = results.filter(result => result.status === 'fulfilled');
  const refused = results.filter(result => result.status === 'rejected');
  expect(acquired).toHaveLength(1);
  expect(refused).toHaveLength(11);
  expect(refused.every(result => result.status === 'rejected'
    && result.reason instanceof ProcessLockHeldError)).toBe(true);
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  expect(persisted.token).toBe((acquired[0] as PromiseFulfilledResult<any>).value.owner.token);
});

test('malformed and explicitly stale lock records are replaced', async () => {
  const path = lockPath();
  writeFileSync(path, '{broken');
  const first = await acquireProcessLockFile({ path, pid: 2001, inspectExisting: () => ({ action: 'refuse' }) });
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(2001);
  await releaseProcessLockFile(first);

  writeFileSync(path, JSON.stringify({ pid: 2002, startedAt: new Date(0).toISOString(), token: 'old' }));
  const second = await acquireProcessLockFile({ path, pid: 2003, inspectExisting: () => ({ action: 'replace' }) });
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(2003);
  await releaseProcessLockFile(second);
});

test('release cannot remove a replacement owner with the same PID', async () => {
  const path = lockPath();
  const old = await acquireProcessLockFile({ path, pid: 3001, token: 'old-token', inspectExisting: () => ({ action: 'refuse' }) });
  writeFileSync(path, JSON.stringify({
    pid: 3001,
    startedAt: new Date().toISOString(),
    token: 'replacement-token',
  }));
  expect(await releaseProcessLockFile(old)).toBe(false);
  expect(JSON.parse(readFileSync(path, 'utf8')).token).toBe('replacement-token');
});

test('a live acquisition guard times out without disturbing the lock', async () => {
  const path = lockPath();
  writeFileSync(`${path}.acquire`, JSON.stringify({
    pid: 4001,
    startedAt: new Date().toISOString(),
    token: 'live-guard',
  }));
  const startedAt = Date.now();
  await expect(acquireProcessLockFile({
    path,
    pid: 4002,
    inspectExisting: () => ({ action: 'replace' }),
    isProcessAlive: () => true,
    guardWaitMs: 15,
    guardRetryMs: 2,
    guardStaleMs: 0,
  })).rejects.toBeInstanceOf(ProcessLockHeldError);
  expect(Date.now() - startedAt).toBeLessThan(250);
  expect(readFileSync(`${path}.acquire`, 'utf8')).toContain('live-guard');
});

test('a stale acquisition guard is recoverable', async () => {
  const path = lockPath();
  writeFileSync(`${path}.acquire`, JSON.stringify({
    pid: 5001,
    startedAt: new Date(0).toISOString(),
    token: 'dead-guard',
  }));
  const handle = await acquireProcessLockFile({
    path,
    pid: 5002,
    inspectExisting: () => ({ action: 'refuse' }),
    isProcessAlive: () => false,
    guardStaleMs: 0,
  });
  expect(handle.owner.pid).toBe(5002);
  await releaseProcessLockFile(handle, { isProcessAlive: () => false, guardStaleMs: 0 });
});

test('process liveness recognizes the current process and rejects unsafe PIDs', () => {
  expect(processExists(process.pid)).toBe(true);
  expect(processExists(0)).toBe(false);
  expect(processExists(-1)).toBe(false);
  expect(processExists(Number.NaN)).toBe(false);
});
