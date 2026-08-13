import { expect, test } from 'bun:test';
import { collectBoundedProcess } from './bounded-subprocess';

const encoder = new TextEncoder();

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function neverStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ pull() {} });
}

test('collects stdout and stderr concurrently with tail bounds', async () => {
  const result = await collectBoundedProcess({
    exited: Promise.resolve(7),
    stdout: stream('x'.repeat(500)),
    stderr: stream('stderr-only'),
  }, {
    timeoutMs: 100,
    maxChars: 100,
    terminate() { throw new Error('must not terminate'); },
  });
  expect(result).toEqual({
    exitCode: 7,
    stdout: 'x'.repeat(100),
    stderr: 'stderr-only',
    timedOut: false,
  });
});

test('timeout remains bounded when process streams and termination all hang', async () => {
  const startedAt = Date.now();
  let terminations = 0;
  const result = await collectBoundedProcess({
    exited: new Promise<number>(() => {}),
    stdout: neverStream(),
    stderr: neverStream(),
  }, {
    timeoutMs: 10,
    terminationTimeoutMs: 10,
    label: 'Discovery fixture',
    terminate() {
      terminations++;
      return new Promise(() => {});
    },
  });
  expect(result).toMatchObject({ timedOut: true, error: 'Discovery fixture timed out after 10ms' });
  expect(terminations).toBe(1);
  expect(Date.now() - startedAt).toBeLessThan(250);
});

test('a broken output stream triggers termination and returns a diagnostic', async () => {
  let terminations = 0;
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('invalid pipe')); } });
  const result = await collectBoundedProcess({
    exited: new Promise<number>(() => {}),
    stdout: broken,
    stderr: stream(''),
  }, {
    timeoutMs: 100,
    terminate() { terminations++; },
  });
  expect(result).toMatchObject({ timedOut: false, error: 'invalid pipe' });
  expect(terminations).toBe(1);
});
