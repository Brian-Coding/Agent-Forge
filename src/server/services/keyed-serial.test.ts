import { expect, test } from 'bun:test';
import { runKeyedSerial } from './keyed-serial';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}

test('same-key operations are ordered while different keys remain parallel', async () => {
  const tails = new Map<string, Promise<void>>();
  const gate = deferred();
  const order: string[] = [];
  const first = runKeyedSerial(tails, 'workspace-a', async () => {
    order.push('first-start');
    await gate.promise;
    order.push('first-end');
    return 1;
  });
  const second = runKeyedSerial(tails, 'workspace-a', async () => {
    order.push('second');
    return 2;
  });
  const other = runKeyedSerial(tails, 'workspace-b', async () => {
    order.push('other');
    return 3;
  });

  expect(await other).toBe(3);
  expect(order).toEqual(['first-start', 'other']);
  gate.resolve();
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  expect(order).toEqual(['first-start', 'other', 'first-end', 'second']);
  expect(tails.size).toBe(0);
});

test('a failed operation reaches its caller and does not poison the next mutation', async () => {
  const tails = new Map<string, Promise<void>>();
  await expect(runKeyedSerial(tails, 'workspace', async () => {
    throw new Error('injected failure');
  })).rejects.toThrow('injected failure');
  expect(await runKeyedSerial(tails, 'workspace', async () => 'recovered')).toBe('recovered');
  expect(tails.size).toBe(0);
});
