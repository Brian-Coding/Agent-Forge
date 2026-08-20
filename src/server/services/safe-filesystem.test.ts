import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SafeFilesystemPolicyError,
  assertSafeTemporaryBase,
  createFreshTempDirectorySync,
  safeMoveDirectory,
  safeRemoveFile,
  safeRemoveTree,
} from './safe-filesystem.mjs';

const testRoots: string[] = [];

async function makeTestRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `agent-forge-safe-fs-${label}-`));
  testRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(testRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('safe filesystem temporary workspaces', () => {
  test('rejects HOME and the workspace root even when listed as approved temp bases', () => {
    expect(() => assertSafeTemporaryBase(homedir(), {
      approvedBaseDirectories: [homedir()],
    })).toThrow(SafeFilesystemPolicyError);
    expect(() => assertSafeTemporaryBase(process.cwd(), {
      approvedBaseDirectories: [process.cwd()],
    })).toThrow(/protected system or workspace path/);
  });

  test('creates a fresh unique directory only beneath an explicitly approved base', async () => {
    const root = await makeTestRoot('fresh');
    const audit: any[] = [];
    const first = createFreshTempDirectorySync({
      prefix: 'agent-forge-fixture-',
      baseDirectory: root,
      approvedBaseDirectories: [root],
      audit: event => audit.push(event),
    });
    const second = createFreshTempDirectorySync({
      prefix: 'agent-forge-fixture-',
      baseDirectory: root,
      approvedBaseDirectories: [root],
      audit: false,
    });

    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(audit).toContainEqual(expect.objectContaining({
      command: 'filesystem.create-fresh-temp-directory',
      decision: 'complete',
      resolvedTarget: first,
    }));
  });
});

describe('safe filesystem destructive preflight', () => {
  test('fails closed for missing, outside-root, populated, and unexpected targets', async () => {
    const root = await makeTestRoot('preflight');
    const allowedRoot = join(root, 'allowed');
    const outside = join(root, 'outside');
    const populated = join(allowedRoot, 'populated');
    await mkdir(populated, { recursive: true });
    await mkdir(outside);
    await writeFile(join(populated, 'unexpected.txt'), 'preserve me');

    await expect(safeRemoveTree({
      targetPath: join(allowedRoot, 'missing'),
      allowedRoot,
      reason: 'Missing target replay',
      mode: 'delete',
      permanent: true,
      audit: false,
    })).rejects.toThrow(/does not exist/);
    await expect(safeRemoveTree({
      targetPath: outside,
      allowedRoot,
      reason: 'Escaped target replay',
      mode: 'delete',
      permanent: true,
      audit: false,
    })).rejects.toThrow(/strictly inside/);
    await expect(safeRemoveTree({
      targetPath: populated,
      allowedRoot,
      reason: 'Unexpected contents replay',
      mode: 'delete',
      permanent: true,
      audit: false,
    })).rejects.toThrow(/populated directory/);
    await expect(safeRemoveTree({
      targetPath: populated,
      allowedRoot,
      reason: 'Unexpected filename replay',
      mode: 'delete',
      permanent: true,
      allowNonEmpty: true,
      allowedTopLevelNames: ['expected.txt'],
      audit: false,
    })).rejects.toThrow(/unexpected top-level entries/);

    expect(await readFile(join(populated, 'unexpected.txt'), 'utf8')).toBe('preserve me');
    expect(existsSync(outside)).toBe(true);
  });

  test('replays a malformed HOME cleanup without touching the home directory', async () => {
    const audit: any[] = [];
    await expect(safeRemoveTree({
      targetPath: homedir(),
      allowedRoot: dirname(homedir()),
      reason: 'Malformed HOME cleanup replay',
      mode: 'delete',
      permanent: true,
      dryRun: true,
      audit: event => audit.push(event),
    })).rejects.toThrow(/protected path|broad enough/);
    expect(existsSync(homedir())).toBe(true);
    expect(audit).toContainEqual(expect.objectContaining({
      command: 'filesystem.remove-tree',
      decision: 'deny',
      target: homedir(),
      code: 'BROAD_ALLOWED_ROOT',
    }));
  });

  test('rejects symlinks or junctions anywhere inside a removal tree', async () => {
    const root = await makeTestRoot('links');
    const allowedRoot = join(root, 'allowed');
    const target = join(allowedRoot, 'target');
    const external = join(root, 'external');
    await mkdir(target, { recursive: true });
    await mkdir(external);
    await writeFile(join(external, 'valuable.txt'), 'keep');
    await symlink(external, join(target, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(safeRemoveTree({
      targetPath: target,
      allowedRoot,
      reason: 'Symlink traversal replay',
      mode: 'delete',
      permanent: true,
      allowNonEmpty: true,
      audit: false,
    })).rejects.toThrow(/symlink or junction/);
    expect(await readFile(join(external, 'valuable.txt'), 'utf8')).toBe('keep');
    expect(existsSync(target)).toBe(true);
  });

  test('requires explicit permanent deletion and supports audited dry-run', async () => {
    const root = await makeTestRoot('dry-run');
    const allowedRoot = join(root, 'allowed');
    const target = join(allowedRoot, 'generated-run');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'artifact.txt'), 'generated');

    await expect(safeRemoveTree({
      targetPath: target,
      allowedRoot,
      reason: 'Permanent acknowledgement replay',
      mode: 'delete',
      allowNonEmpty: true,
      audit: false,
    })).rejects.toThrow(/permanent: true/);

    const audit: any[] = [];
    const result = await safeRemoveTree({
      targetPath: target,
      allowedRoot,
      reason: 'Dry-run generated cleanup',
      mode: 'delete',
      permanent: true,
      allowNonEmpty: true,
      dryRun: true,
      audit: event => audit.push(event),
    });
    expect(result.status).toBe('dry-run');
    expect(existsSync(target)).toBe(true);
    expect(audit).toContainEqual(expect.objectContaining({
      command: 'filesystem.remove-tree',
      decision: 'dry-run',
      resolvedTarget: target,
      entryCount: 1,
    }));
  });
});

describe('safe filesystem guarded operations', () => {
  test('quarantines by default and permanently removes only expected generated content', async () => {
    const root = await makeTestRoot('remove');
    const allowedRoot = join(root, 'allowed');
    const quarantined = join(allowedRoot, 'quarantine-me');
    const generated = join(allowedRoot, 'delete-me');
    await mkdir(quarantined, { recursive: true });
    await mkdir(generated);
    await writeFile(join(quarantined, 'known.txt'), 'recoverable');
    await writeFile(join(generated, 'known.txt'), 'generated');

    const quarantineResult = await safeRemoveTree({
      targetPath: quarantined,
      allowedRoot,
      reason: 'Recoverable cleanup fixture',
      allowNonEmpty: true,
      allowedTopLevelNames: ['known.txt'],
      audit: false,
    });
    expect(quarantineResult.status).toBe('quarantined');
    expect(existsSync(quarantined)).toBe(false);
    expect(await readFile(join(quarantineResult.path, 'known.txt'), 'utf8')).toBe('recoverable');

    const deleteResult = await safeRemoveTree({
      targetPath: generated,
      allowedRoot,
      reason: 'Permanent generated cleanup fixture',
      mode: 'delete',
      permanent: true,
      allowNonEmpty: true,
      allowedTopLevelNames: ['known.txt'],
      audit: false,
    });
    expect(deleteResult.status).toBe('deleted');
    expect(existsSync(generated)).toBe(false);
  });

  test('guards individual files and directory moves with the same root policy', async () => {
    const root = await makeTestRoot('file-move');
    const allowedRoot = join(root, 'allowed');
    const file = join(allowedRoot, 'old.png');
    const source = join(allowedRoot, 'source');
    const destination = join(allowedRoot, 'destination');
    const occupiedDestination = join(allowedRoot, 'occupied');
    await mkdir(source, { recursive: true });
    await mkdir(occupiedDestination);
    await writeFile(file, 'png');
    await writeFile(join(source, 'known.txt'), 'move');
    await writeFile(join(occupiedDestination, 'valuable.txt'), 'preserve');

    const fileResult = await safeRemoveFile({
      targetPath: file,
      allowedRoot,
      reason: 'Expired generated screenshot',
      mode: 'delete',
      permanent: true,
      expectedTargetName: /\.png$/,
      audit: false,
    });
    expect(fileResult.status).toBe('deleted');
    expect(existsSync(file)).toBe(false);

    await expect(safeMoveDirectory({
      targetPath: source,
      destinationPath: join(root, 'escaped'),
      allowedRoot,
      reason: 'Escaped move replay',
      allowNonEmpty: true,
      audit: false,
    })).rejects.toThrow(/inside the allowed root/);
    expect(existsSync(source)).toBe(true);

    await expect(safeMoveDirectory({
      targetPath: source,
      destinationPath: occupiedDestination,
      allowedRoot,
      reason: 'Pre-existing destination replay',
      allowNonEmpty: true,
      audit: false,
    })).rejects.toThrow(/already exists/);
    expect(await readFile(join(occupiedDestination, 'valuable.txt'), 'utf8')).toBe('preserve');
    expect(existsSync(source)).toBe(true);

    const moveResult = await safeMoveDirectory({
      targetPath: source,
      destinationPath: destination,
      allowedRoot,
      reason: 'Atomic generated directory move',
      allowNonEmpty: true,
      allowedTopLevelNames: ['known.txt'],
      audit: false,
    });
    expect(moveResult.status).toBe('moved');
    expect(existsSync(source)).toBe(false);
    expect(await readFile(join(destination, 'known.txt'), 'utf8')).toBe('move');
  });
});
