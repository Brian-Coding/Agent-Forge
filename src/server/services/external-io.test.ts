import { expect, test } from 'bun:test';
import { ExternalTimeoutError, fetchWithTimeout, readJsonResponseWithTimeout } from './external-io';

test('bounded fetch returns a normal response and clears its deadline', async () => {
  const response = await fetchWithTimeout('https://example.invalid', {}, 100, 'fixture', async () =>
    new Response('{"ok":true}', { status: 200 }));
  expect(await response.json()).toEqual({ ok: true });
});

test('bounded fetch rejects on schedule even when the transport ignores abort', async () => {
  const startedAt = Date.now();
  await expect(fetchWithTimeout(
    'https://example.invalid',
    {},
    10,
    'Google fixture',
    async () => new Promise<Response>(() => {}),
  )).rejects.toBeInstanceOf(ExternalTimeoutError);
  expect(Date.now() - startedAt).toBeLessThan(250);
});

test('bounded fetch forwards an upstream cancellation signal', async () => {
  const upstream = new AbortController();
  let receivedAborted = false;
  const pending = fetchWithTimeout('https://example.invalid', { signal: upstream.signal }, 1_000, 'fixture', async (_input, init) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return reject(new Error('signal missing'));
      const rejectAborted = () => {
        receivedAborted = signal.aborted;
        reject(signal.reason);
      };
      if (signal.aborted) rejectAborted();
      else signal.addEventListener('abort', rejectAborted, { once: true });
    });
  });
  upstream.abort(new Error('caller cancelled'));
  await expect(pending).rejects.toThrow('caller cancelled');
  expect(receivedAborted).toBe(true);
});

test('bounded JSON response reading handles split input and exact byte limits', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"ok":'));
      controller.enqueue(encoder.encode('true}'));
      controller.close();
    },
  });
  expect(await readJsonResponseWithTimeout(new Response(body), 11, 100, 'fixture')).toEqual({ ok: true });
  expect(body.locked).toBe(false);
});

test('bounded JSON response reading rejects oversized, malformed, and hanging bodies', async () => {
  await expect(readJsonResponseWithTimeout(new Response('12345', {
    headers: { 'content-length': '5' },
  }), 4, 100, 'fixture')).rejects.toThrow('exceeded 4 bytes');
  await expect(readJsonResponseWithTimeout(new Response('{'), 100, 100, 'fixture')).rejects.toThrow('invalid JSON');

  const hanging = new ReadableStream<Uint8Array>({ start() {} });
  const startedAt = Date.now();
  await expect(readJsonResponseWithTimeout(new Response(hanging), 100, 10, 'hanging fixture'))
    .rejects.toBeInstanceOf(ExternalTimeoutError);
  expect(Date.now() - startedAt).toBeLessThan(1_000);
});
