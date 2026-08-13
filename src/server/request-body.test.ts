import { expect, test } from 'bun:test';
import {
  readJsonBody,
  readRequestBytes,
  RequestBodyError,
} from './request-body';

test('bounded request reading accepts exact-limit chunked input', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close();
    },
  });
  const bytes = await readRequestBytes(new Request('http://localhost', { method: 'POST', body, duplex: 'half' } as RequestInit), 4);
  expect([...bytes]).toEqual([1, 2, 3, 4]);
  expect(body.locked).toBe(false);
});

test('declared and streaming body overruns fail with 413 before full buffering', async () => {
  const declared = new Request('http://localhost', {
    method: 'POST',
    headers: { 'content-length': '100' },
    body: 'x',
  });
  await expect(readRequestBytes(declared, 10)).rejects.toMatchObject({ status: 413 });

  let cancelled = false;
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
    },
    cancel() { cancelled = true; },
  });
  await expect(readRequestBytes(new Request('http://localhost', {
    method: 'POST',
    body: streamed,
    duplex: 'half',
  } as RequestInit), 10)).rejects.toMatchObject({ status: 413 });
  expect(cancelled).toBe(true);
});

test('JSON bodies reject malformed JSON and invalid UTF-8 with typed errors', async () => {
  await expect(readJsonBody(new Request('http://localhost', { method: 'POST', body: '{' }), 100))
    .rejects.toBeInstanceOf(RequestBodyError);
  const bytes = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xc3, 0x28]));
      controller.close();
    },
  });
  await expect(readJsonBody(new Request('http://localhost', {
    method: 'POST',
    body: bytes,
    duplex: 'half',
  } as RequestInit), 100)).rejects.toThrow('valid UTF-8');
});

test('invalid Content-Length and invalid configured limits are explicit', async () => {
  const req = new Request('http://localhost', {
    method: 'POST',
    headers: { 'content-length': '-1' },
    body: 'x',
  });
  await expect(readRequestBytes(req, 10)).rejects.toMatchObject({ status: 400 });
  await expect(readRequestBytes(new Request('http://localhost'), Number.NaN)).rejects.toThrow('Invalid request-body limit');
});
