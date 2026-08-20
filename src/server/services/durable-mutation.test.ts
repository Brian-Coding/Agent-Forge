import { expect, test } from 'bun:test';
import { runDurableMutation } from './durable-mutation';

test('durable mutations run one at a time and continue after a failure', async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = runDurableMutation(async () => {
    events.push('first:start');
    await firstMayFinish;
    events.push('first:fail');
    throw new Error('injected failure');
  });
  const second = runDurableMutation(async () => {
    events.push('second:start');
    events.push('second:finish');
    return 2;
  });

  await Promise.resolve();
  expect(events).toEqual(['first:start']);
  releaseFirst();
  await expect(first).rejects.toThrow('injected failure');
  expect(await second).toBe(2);
  expect(events).toEqual(['first:start', 'first:fail', 'second:start', 'second:finish']);
});
