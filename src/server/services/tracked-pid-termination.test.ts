import { expect, test } from 'bun:test';
import { terminateTrackedPids } from './agent.service';

test('tracked PID termination filters unsafe values, deduplicates, and reports partial failure', async () => {
  const attempted: number[] = [];
  const summary = await terminateTrackedPids([
    -1,
    0,
    1,
    process.pid,
    4242,
    4242,
    4343,
    Number.NaN,
  ], async pid => {
    attempted.push(pid);
    return {
      attempted: true,
      succeeded: pid === 4242,
      exitCode: pid === 4242 ? 0 : 1,
      timedOut: false,
      ...(pid === 4242 ? {} : { error: 'injected failure' }),
    };
  });

  expect(attempted).toEqual([4242, 4343]);
  expect(summary.succeeded).toEqual([4242]);
  expect(summary.failed).toEqual([{
    pid: 4343,
    result: {
      attempted: true,
      succeeded: false,
      exitCode: 1,
      timedOut: false,
      error: 'injected failure',
    },
  }]);
});

test('one throwing termination does not skip independent tracked children', async () => {
  const attempted: number[] = [];
  const summary = await terminateTrackedPids([5001, 5002, 5003], async pid => {
    attempted.push(pid);
    if (pid === 5002) throw new Error('termination transport failed');
    return { attempted: true, succeeded: true, exitCode: 0, timedOut: false };
  });
  expect(attempted).toEqual([5001, 5002, 5003]);
  expect(summary.succeeded).toEqual([5001, 5003]);
  expect(summary.failed[0]).toMatchObject({ pid: 5002, result: { error: 'termination transport failed' } });
});
