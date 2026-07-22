import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectFileAccessError, resolveProjectTextFile } from './project-file.routes';

const tempRoots: string[] = [];

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-forge-project-file-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

test('project report files resolve inside the agent working directory', () => {
  const root = makeProject();
  const reports = join(root, '.plans');
  mkdirSync(reports);
  const report = join(reports, 'final-runbook.md');
  writeFileSync(report, '# Final runbook');
  expect(resolveProjectTextFile(root, report)).toBe(report);
});

test('project file access rejects traversal and non-text files', () => {
  const root = makeProject();
  const outside = makeProject();
  const outsideReport = join(outside, 'private.md');
  const binary = join(root, 'artifact.exe');
  writeFileSync(outsideReport, '# Outside');
  writeFileSync(binary, 'binary');

  expect(() => resolveProjectTextFile(root, outsideReport)).toThrow(ProjectFileAccessError);
  expect(() => resolveProjectTextFile(root, binary)).toThrow('Only project text and report files can be opened');
});
