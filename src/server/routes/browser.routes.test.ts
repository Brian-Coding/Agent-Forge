import { expect, test } from 'bun:test';
import {
  handleBrowserClick,
  handleBrowserNavigate,
  handleBrowserScreenshot,
  handleBrowserViewport,
} from './browser.routes';

async function body(response: Response): Promise<any> {
  return response.json();
}

test('browser mutations preserve malformed, oversized, and invalid UTF-8 body errors', async () => {
  const malformed = await handleBrowserNavigate(new Request('http://localhost/api/browser/navigate', {
    method: 'POST',
    body: '{broken',
    headers: { 'content-type': 'application/json' },
  }));
  expect(malformed.status).toBe(400);
  expect((await body(malformed)).error).toContain('valid JSON');

  const oversized = await handleBrowserClick(new Request('http://localhost/api/browser/click', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: 'w', selector: 'x'.repeat(1024 * 1024) }),
    headers: { 'content-type': 'application/json' },
  }));
  expect(oversized.status).toBe(413);
  expect((await body(oversized)).error).toContain('exceeds 1048576 bytes');

  const invalidUtf8 = await handleBrowserViewport(new Request('http://localhost/api/browser/viewport', {
    method: 'POST',
    body: new Uint8Array([0xff, 0xfe]),
  }));
  expect(invalidUtf8.status).toBe(400);
  expect((await body(invalidUtf8)).error).toContain('UTF-8');
});

test('browser route validation rejects unsafe session IDs, ranges, and Atlas output traversal before worker startup', async () => {
  const invalidSession = await handleBrowserNavigate(new Request('http://localhost/api/browser/navigate', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: 'w', url: 'about:blank', browserSessionId: '../escape' }),
  }));
  expect(invalidSession.status).toBe(400);
  expect(await body(invalidSession)).toMatchObject({ error: 'invalid browserSessionId' });

  const invalidViewport = await handleBrowserViewport(new Request('http://localhost/api/browser/viewport', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: 'w', width: 1, height: Number.NaN }),
  }));
  expect(invalidViewport.status).toBe(400);
  expect((await body(invalidViewport)).error).toContain('width');

  const traversal = await handleBrowserScreenshot(new Request('http://localhost/api/browser/screenshot', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: 'missing', outDir: 'C:\\outside', runId: '../bad' }),
  }));
  expect(traversal.status).toBe(400);
  expect((await body(traversal)).error).toBe('invalid runId');
});
