import { expect, test } from 'bun:test';
import {
  drainStreamToString,
  flushNdjsonLeftover,
  parseNdjsonLines,
  sanitizeCliText,
} from './stream-utils';

const encoder = new TextEncoder();

function chunks(...values: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

test('stream draining preserves split UTF-8 characters, caps the final tail, and releases its lock', async () => {
  const encoded = encoder.encode('prefix🙂suffix');
  const stream = chunks(encoded.slice(0, 8), encoded.slice(8, 10), encoded.slice(10));

  expect(await drainStreamToString(stream, 8)).toBe('🙂suffix');
  expect(stream.locked).toBe(false);
});

test('stream draining can retain the bounded head while still consuming the source', async () => {
  const stream = chunks(encoder.encode('prefix'), encoder.encode('-suffix'));
  expect(await drainStreamToString(stream, 7, undefined, 'head')).toBe('prefix-');
  expect(stream.locked).toBe(false);
});

test('stream draining releases its reader after a source error', async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('interrupted stdout'));
    },
  });

  await expect(drainStreamToString(stream)).rejects.toThrow('interrupted stdout');
  expect(stream.locked).toBe(false);
});

test('NDJSON parsing handles CRLF, blank lines, malformed records, and final partial lines', () => {
  const events: any[] = [];
  const remainder = parseNdjsonLines('{"a":1}\r\nnot-json\n\n{"b":2', event => events.push(event));
  expect(events).toEqual([{ a: 1 }]);
  expect(remainder).toBe('{"b":2');

  flushNdjsonLeftover(`${remainder}}`, event => events.push(event));
  expect(events).toEqual([{ a: 1 }, { b: 2 }]);
});

test('a handler failure is isolated to its line and later NDJSON still parses', () => {
  const seen: number[] = [];
  parseNdjsonLines('{"n":1}\n{"n":2}\n{"n":3}\n', event => {
    if (event.n === 2) throw new Error('consumer rejected event');
    seen.push(event.n);
  });
  expect(seen).toEqual([1, 3]);
});

test('CLI sanitizer strips ANSI/control corruption without discarding ordinary unicode', () => {
  expect(sanitizeCliText('\u001b[31mred\u001b[0m café')).toBe('red café');
  expect(sanitizeCliText('\u0000\u0001\u0002\u0003\u0004\u0005')).toBe('');
});
