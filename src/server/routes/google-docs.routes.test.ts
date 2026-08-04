import { describe, expect, test } from 'bun:test';
import { handleGoogleDocsAppend, handleGoogleDocsIntegration, handleGoogleDocsReplace } from './google-docs.routes';

describe('Google Docs routes', () => {
  test('rejects non-Google document URLs before configuration', async () => {
    const response = await handleGoogleDocsIntegration(new Request('http://localhost/api/integrations/google-docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentUrl: 'https://example.com/not-a-doc' }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('docs.google.com');
  });

  test('validates mutation bodies before touching Google', async () => {
    const append = await handleGoogleDocsAppend(new Request('http://localhost/api/google-docs/append', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }), false);
    expect(append.status).toBe(400);

    const replace = await handleGoogleDocsReplace(new Request('http://localhost/api/google-docs/replace', {
      method: 'POST', body: JSON.stringify({ search: '' }), headers: { 'Content-Type': 'application/json' },
    }));
    expect(replace.status).toBe(400);

    const invalidTab = await handleGoogleDocsAppend(new Request('http://localhost/api/google-docs/append', {
      method: 'POST', body: JSON.stringify({ text: 'Task', tabId: 123 }), headers: { 'Content-Type': 'application/json' },
    }), false);
    expect(invalidTab.status).toBe(400);
    expect((await invalidTab.json()).error).toContain('tabId');
  });
});
