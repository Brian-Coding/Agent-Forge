import { describe, expect, test } from 'bun:test';
import { createProcessProbe, interpretPosixPsResult } from './process-probe';

describe('interpretPosixPsResult', () => {
  test('treats procps exit 1 with empty output as missing when the PID is gone', () => {
    expect(interpretPosixPsResult(4242, { exitCode: 1, stdout: '', stderr: '' }, () => true)).toBeNull();
    expect(interpretPosixPsResult(4242, { exitCode: 1, stdout: '\n', stderr: '  ' }, () => true)).toBeNull();
  });

  test('keeps silent ps failure ambiguous when kill(pid, 0) says the PID still exists', () => {
    expect(() => interpretPosixPsResult(4242, { exitCode: 1, stdout: '', stderr: '' }, () => false))
      .toThrow('ps exited 1');
  });

  test('still reports explicit ps errors and other exit codes', () => {
    expect(interpretPosixPsResult(4242, { exitCode: 1, stdout: '', stderr: 'ps: no such process' }, () => false)).toBeNull();
    expect(() => interpretPosixPsResult(4242, { exitCode: 2, stdout: '', stderr: '' }, () => true)).toThrow('ps exited 2');
    expect(() => interpretPosixPsResult(4242, { exitCode: 1, stdout: '', stderr: 'ps: weird failure' }, () => true))
      .toThrow('weird failure');
  });

  test('parses a live ps row', () => {
    const identity = interpretPosixPsResult(
      4242,
      { exitCode: 0, stdout: ' 4242     1 Mon Oct 12 10:00:00 2026 bun\n', stderr: '' },
      () => false,
    );
    expect(identity).toMatchObject({ pid: 4242, parentPid: 1, name: 'bun' });
    expect(identity?.startTimeMs).toBeNumber();
  });
});

test.skipIf(process.platform === 'win32')('real POSIX probe reports a dead PID as missing', async () => {
  const child = Bun.spawn(['true']);
  await child.exited;
  const result = await createProcessProbe().probe(child.pid);
  expect(result.status).toBe('missing');
});
