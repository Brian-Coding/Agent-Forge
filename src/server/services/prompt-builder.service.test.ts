import { expect, test } from 'bun:test';
import {
  getBuiltInHarnessInstructionManifest,
  LEGACY_SHARED_PROJECT_CONTEXT,
  normalizeSharedProjectContext,
  shouldInjectGoogleDocsTracker,
} from './prompt-builder.service';

test('legacy shared standards migrate into the built-in harness policy without duplication', () => {
  expect(normalizeSharedProjectContext(LEGACY_SHARED_PROJECT_CONTEXT)).toBe('');
  expect(normalizeSharedProjectContext(`\r\n${LEGACY_SHARED_PROJECT_CONTEXT.replace(/\n/g, '\r\n')}\r\n`)).toBe('');
});

test('additional project-specific context remains editable and injectable', () => {
  expect(normalizeSharedProjectContext('Use PostgreSQL 18 for this project.')).toBe('Use PostgreSQL 18 for this project.');
});

test('Harness Settings exposes the exact built-in instruction sections', () => {
  const manifest = getBuiltInHarnessInstructionManifest();
  expect(manifest.sections.map(section => section.id)).toEqual(['guardrails', 'standards', 'reports', 'plans', 'scope']);
  expect(manifest.sections.find(section => section.id === 'standards')?.content).toContain(LEGACY_SHARED_PROJECT_CONTEXT);
  expect(manifest.sections.find(section => section.id === 'reports')?.content).toContain('directly in the final chat response');
  expect(manifest.sections.find(section => section.id === 'reports')?.content).toContain('Never make a bare local filesystem link the only delivery');
  expect(manifest.assemblyOrder.length).toBe(7);
});

test('Google Docs tracker context is workspace opt-in', () => {
  expect(shouldInjectGoogleDocsTracker({}, undefined)).toBe(false);
  expect(shouldInjectGoogleDocsTracker({}, {})).toBe(false);
  expect(shouldInjectGoogleDocsTracker({}, { googleDocsTrackerEnabled: false })).toBe(false);
  expect(shouldInjectGoogleDocsTracker({}, { googleDocsTrackerEnabled: true })).toBe(true);
  expect(shouldInjectGoogleDocsTracker({ hideFromGrid: true }, { googleDocsTrackerEnabled: true })).toBe(false);
});
