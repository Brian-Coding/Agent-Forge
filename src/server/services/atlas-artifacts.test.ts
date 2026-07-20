import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  atlasCandidatePaths,
  createAtlasCandidate,
  promoteAtlasCandidate,
  validateAtlasCandidate,
} from './atlas-artifacts';

const tempProjects: string[] = [];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'agent-forge-atlas-'));
  tempProjects.push(project);
  return project;
}

afterEach(() => {
  while (tempProjects.length) {
    const project = tempProjects.pop()!;
    rmSync(project, { recursive: true, force: true });
  }
});

async function writeValidCandidate(project: string, runId: string): Promise<void> {
  const paths = await createAtlasCandidate(project, runId);
  await writeFile(join(paths.candidateRoot, 'shots', 'surface-home.png'), PNG_SIGNATURE);
  await writeFile(join(paths.candidateRoot, 'atlas.md'), [
    '---',
    'schema_version: 1',
    'last_full_scan: 2026-07-14T12:00:00.000Z',
    'total_surfaces: 1',
    'total_entities: 1',
    '---',
    '',
    '# UI Atlas — Fixture',
    '',
    '## Visual surfaces',
    '### `surface.home` — Home',
    '- Screenshot: `shots/surface-home.png`',
    '- Last verified: 2026-07-14',
  ].join('\n'));
  await writeFile(join(paths.candidateRoot, 'atlas.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    generatedAt: '2026-07-14T12:00:00.000Z',
    entities: [{ id: 'entity.user', name: 'User' }],
    surfaces: [{
      id: 'surface.home',
      name: 'Home',
      status: 'verified',
      screenshotRefs: ['shots/surface-home.png'],
      entityIds: ['entity.user'],
    }],
    flows: [],
  }, null, 2));
  await writeFile(join(paths.candidateRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    atlasSchemaVersion: 1,
    runId,
    status: 'complete',
    generatedAt: '2026-07-14T12:00:00.000Z',
  }, null, 2));
  await writeFile(join(paths.candidateRoot, 'checkpoint.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    status: 'complete',
    phase: 'complete',
    completedSurfaceIds: ['surface.home'],
    lastActivityAt: '2026-07-14T12:00:00.000Z',
  }, null, 2));
  await writeFile(join(paths.candidateRoot, 'README.md'), '# Atlas');
  await writeFile(join(paths.candidateRoot, 'changelog.md'), '# Changes');
}

describe('Atlas candidate publication', () => {
  test('rejects a verified surface whose evidence is missing', async () => {
    const project = makeProject();
    const runId = 'missing-evidence';
    await writeValidCandidate(project, runId);
    const paths = atlasCandidatePaths(project, runId);
    rmSync(join(paths.candidateRoot, 'shots', 'surface-home.png'));

    const result = await validateAtlasCandidate(project, runId);
    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.includes('does not exist'))).toBe(true);
  });

  test('rejects an incomplete required bundle and fake PNG evidence', async () => {
    const project = makeProject();
    const runId = 'invalid-bundle';
    await writeValidCandidate(project, runId);
    const paths = atlasCandidatePaths(project, runId);
    rmSync(join(paths.candidateRoot, 'README.md'));
    await writeFile(join(paths.candidateRoot, 'shots', 'surface-home.png'), 'not-a-png');

    const result = await validateAtlasCandidate(project, runId);
    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.includes('README.md is missing'))).toBe(true);
    expect(result.errors.some(error => error.includes('PNG signature'))).toBe(true);
  });

  test('publishes a valid candidate and archives the previous Atlas', async () => {
    const project = makeProject();
    const canonical = join(project, 'docs', 'ui-atlas');
    await mkdir(join(canonical, 'shots'), { recursive: true });
    await writeFile(join(canonical, 'atlas.md'), '# Last good Atlas');
    await writeFile(join(canonical, 'shots', 'old.png'), 'old-png');

    const runId = 'publish-good';
    await writeValidCandidate(project, runId);
    const result = await promoteAtlasCandidate(project, runId);

    expect(result.valid).toBe(true);
    expect(await readFile(join(canonical, 'atlas.md'), 'utf8')).toContain('Fixture');
    expect(existsSync(join(canonical, 'atlas.json'))).toBe(true);
    const historyEntries = await readdir(join(canonical, '.history'));
    expect(historyEntries.length).toBe(1);
    expect(await readFile(join(canonical, '.history', historyEntries[0]!, 'atlas.md'), 'utf8')).toContain('Last good');
  });

  test('recovers a last-good Atlas left in rollback before publishing', async () => {
    const project = makeProject();
    const runId = 'recover-rollback';
    const canonical = join(project, 'docs', 'ui-atlas');
    const rollback = join(project, 'docs', `.ui-atlas-rollback-${runId}`);
    await mkdir(rollback, { recursive: true });
    await writeFile(join(rollback, 'atlas.md'), '# Last good after interrupted swap');
    await writeValidCandidate(project, runId);

    const result = await promoteAtlasCandidate(project, runId);

    expect(result.valid).toBe(true);
    expect(await readFile(join(canonical, 'atlas.md'), 'utf8')).toContain('Fixture');
    const historyEntries = await readdir(join(canonical, '.history'));
    expect(await readFile(join(canonical, '.history', historyEntries[0]!, 'atlas.md'), 'utf8'))
      .toContain('Last good after interrupted swap');
    expect(existsSync(rollback)).toBe(false);
  });

  test('treats a retry after successful publication as idempotent', async () => {
    const project = makeProject();
    const runId = 'idempotent-publish';
    await writeValidCandidate(project, runId);

    await promoteAtlasCandidate(project, runId);
    const retry = await promoteAtlasCandidate(project, runId);

    expect(retry.valid).toBe(true);
    expect(await readFile(join(project, 'docs', 'ui-atlas', 'atlas.md'), 'utf8')).toContain('Fixture');
  });
});
