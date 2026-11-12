import { expect, test } from 'bun:test';
import {
  getBuiltInHarnessInstructionManifest,
  normalizeSharedProjectContext,
} from './prompt-builder.service';

test('additional project-specific context remains editable and injectable', () => {
  expect(normalizeSharedProjectContext('Use PostgreSQL 18 for this project.')).toBe('Use PostgreSQL 18 for this project.');
  expect(normalizeSharedProjectContext('  padded\n')).toBe('padded');
  expect(normalizeSharedProjectContext(undefined)).toBe('');
});

test('Harness Settings exposes the exact built-in instruction sections', () => {
  const manifest = getBuiltInHarnessInstructionManifest();
  const guardrails = manifest.sections.find(section => section.id === 'guardrails')?.content;
  expect(manifest.sections.map(section => section.id)).toEqual(['guardrails', 'reports', 'plans', 'scope']);
  expect(guardrails).toContain('inspect the current branch and all local and remote-tracking branches');
  expect(guardrails).toContain('NEVER commit or push directly to master');
  expect(guardrails).toContain('only when no develop branch exists locally or remotely');
  expect(guardrails).toContain('resolve every target to an absolute real path');
  expect(guardrails).toContain('Never reuse HOME, USERPROFILE, CODEX_HOME');
  expect(guardrails).toContain('recoverable quarantine or trash operation');
  expect(guardrails).toContain('unexpectedly populated');
  expect(manifest.sections.find(section => section.id === 'reports')?.content).toContain('directly in the final chat response');
  expect(manifest.sections.find(section => section.id === 'reports')?.content).toContain('Never make a bare local filesystem link the only delivery');
  expect(manifest.assemblyOrder.length).toBe(7);
});

test('built-in instructions carry no personal or vendor-specific operating rules', () => {
  const all = getBuiltInHarnessInstructionManifest().sections.map(section => section.content).join('\n');
  expect(all).not.toMatch(/vercel|co-authored|what model is replying/i);
});
