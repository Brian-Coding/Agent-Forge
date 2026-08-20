import { describe, expect, test } from 'bun:test';
import {
  buildGoogleDocsAgentInstructions,
  extractGoogleDocument,
  parseGoogleDocumentUrl,
  validateGoogleBatchUpdatePayload,
  validateGoogleDocumentPayload,
  validateServiceAccountCredential,
} from './google-docs.service';

describe('Google Docs service', () => {
  test('parses and allowlists Google document URLs', () => {
    expect(parseGoogleDocumentUrl('https://docs.google.com/document/d/doc_123/edit?tab=t.0')).toEqual({
      documentUrl: 'https://docs.google.com/document/d/doc_123/edit?tab=t.0',
      documentId: 'doc_123',
      tabId: 't.0',
    });
    expect(() => parseGoogleDocumentUrl('https://example.com/document/d/doc_123')).toThrow('docs.google.com');
  });

  test('extracts the configured tab including table text', () => {
    const result = extractGoogleDocument({
      title: 'Tracker',
      revisionId: 'rev-1',
      tabs: [{
        tabProperties: { tabId: 't.0', title: 'Roadmap' },
        documentTab: { body: { content: [
          { paragraph: { elements: [{ textRun: { content: 'Scheduling\n' } }] } },
          { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Needed' } }] } }] }] }] } },
        ] } },
      }],
    }, 't.0');
    expect(result).toMatchObject({ title: 'Tracker', revisionId: 'rev-1', tabId: 't.0', tabTitle: 'Roadmap' });
    expect(result.text).toBe('Scheduling\nNeeded');
  });

  test('preserves ordered parent and child tab hierarchy while keeping a flat lookup', () => {
    const result = extractGoogleDocument({
      title: 'Tracker',
      revisionId: 'rev-2',
      tabs: [{
        tabProperties: { tabId: 'root', title: 'AI Test', index: 0, nestingLevel: 0 },
        documentTab: { body: { content: [] } },
        childTabs: [
          { tabProperties: { tabId: 'missing', title: 'Missing features', index: 0, nestingLevel: 1 }, documentTab: { body: { content: [] } } },
          { tabProperties: { tabId: 'bugs', title: 'Bug', index: 1, nestingLevel: 1 }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Unfixed\n' } }] } }] } } },
        ],
      }],
    });

    expect(result.tabs.map(tab => tab.id)).toEqual(['root', 'missing', 'bugs']);
    expect(result.tabs.at(2)).toMatchObject({ parentTabId: 'root', index: 1, nestingLevel: 1, path: ['AI Test', 'Bug'], text: 'Unfixed\n' });
    expect(result.tabTree.at(0)?.children.map(tab => tab.id)).toEqual(['missing', 'bugs']);
  });

  test('agent instructions require git reconciliation, deduplication, and revision safety', () => {
    const instructions = buildGoogleDocsAgentInstructions({
      documentUrl: 'https://docs.google.com/document/d/doc_123/edit',
      documentId: 'doc_123',
    }, 3333);
    expect(instructions).toContain('git history');
    expect(instructions).toContain('/append-if-absent');
    expect(instructions).toContain('"tabId":"target tab ID"');
    expect(instructions).toContain('parentTabId');
    expect(instructions).toContain('To move an item');
    expect(instructions).toContain('revision conflict');
    expect(instructions).not.toContain('private_key');
  });

  test('rejects empty or partial HTTP 200 payloads instead of reporting a connection or write success', () => {
    expect(() => validateGoogleDocumentPayload({})).toThrow('incomplete document response');
    expect(() => validateGoogleDocumentPayload({
      documentId: 'doc',
      title: 'Tracker',
      revisionId: 'rev',
      tabs: [],
    })).not.toThrow();
    expect(() => validateGoogleBatchUpdatePayload({})).toThrow('malformed write response');
    expect(() => validateGoogleBatchUpdatePayload({ documentId: 'doc', replies: [] })).not.toThrow();
  });

  test('service-account token endpoints cannot redirect credential assertions to arbitrary hosts', () => {
    const base = {
      type: 'service_account',
      client_email: 'fixture@example.iam.gserviceaccount.com',
      private_key: 'private-key-fixture',
    };
    expect(() => validateServiceAccountCredential({
      ...base,
      token_uri: 'http://127.0.0.1/collect',
    })).toThrow('HTTPS Google API endpoint');
    expect(() => validateServiceAccountCredential({
      ...base,
      token_uri: 'https://oauth2.googleapis.com/token',
    })).not.toThrow();
  });
});
