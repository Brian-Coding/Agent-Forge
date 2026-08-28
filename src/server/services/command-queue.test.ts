import { expect, test } from 'bun:test';
import { createCommandQueue, MAX_COMMAND_QUEUE_DEPTH } from './command-queue';

test('a process-local queue runs jobs in order and reports snapshots', async () => {
  const snapshots: string[][] = [];
  const started: string[] = [];
  const queue = createCommandQueue({
    onChange: snapshot => { snapshots.push(snapshot.items.map(item => `${item.status}:${item.preview}`)); },
  });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  queue.enqueue('a1', 'r1', 1, 'one', async () => { started.push('one'); await firstGate; });
  queue.enqueue('a1', 'r2', 2, 'two', async () => { started.push('two'); });
  expect(queue.size('a1')).toBe(2);
  expect(queue.snapshot('a1').items.map(item => item.status)).toEqual(['running', 'queued']);
  releaseFirst();
  await waitUntil(() => started.includes('two'));
  expect(started).toEqual(['one', 'two']);
  expect(queue.size('a1')).toBe(0);
});

test('queue depth is bounded and does not persist across reset', () => {
  const queue = createCommandQueue();
  for (let i = 0; i < MAX_COMMAND_QUEUE_DEPTH; i++) {
    expect(queue.enqueue('a1', `r${i}`, i, `p${i}`, async () => { await Bun.sleep(50); })).not.toBeNull();
  }
  expect(queue.enqueue('a1', 'overflow', 99, 'nope', async () => {})).toBeNull();
  queue.reset('a1');
  expect(queue.size('a1')).toBe(0);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
