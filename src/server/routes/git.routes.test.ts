import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boundedDiff, hasSuccessfulGitOutput, resolveGitDiffTarget, runGit } from './git.routes';

test('Git diff review resolves only files inside the agent project', () => {
  const root = resolve('C:/projects/example');
  expect(resolveGitDiffTarget(root, 'src/app.ts')).toEqual({
    absolutePath: resolve(root, 'src/app.ts'),
    relativePath: join('src', 'app.ts'),
  });
  expect(() => resolveGitDiffTarget(root, '../outside.txt')).toThrow('outside this agent project');
  expect(() => resolveGitDiffTarget(root, root)).toThrow('outside this agent project');
});

test('untracked diff reads resolve symlinks before opening the file', () => {
  const source = readFileSync(join(import.meta.dir, 'git.routes.ts'), 'utf8');
  expect(source).toContain('resolveGitDiffTarget(realpathSync(agent.cwd), realpathSync(target.absolutePath));');
  expect(source.indexOf('realpathSync(target.absolutePath)')).toBeLessThan(source.indexOf('const file = Bun.file(target.absolutePath)'));
});

test('nonzero Git commands cannot masquerade as successful diff output', () => {
  expect(hasSuccessfulGitOutput({ exitCode: 1, stdout: 'plausible-looking diff' })).toBe(false);
  expect(hasSuccessfulGitOutput({ exitCode: 0, stdout: '  ' })).toBe(false);
  expect(hasSuccessfulGitOutput({ exitCode: 0, stdout: 'diff --git a/x b/x' })).toBe(true);
});

test('Git subprocess handling supports spaced paths, nonzero exits, and bounded output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af git route '));
  try {
    expect((await runGit(root, ['init'])).exitCode).toBe(0);
    writeFileSync(join(root, 'large file.txt'), 'before\n');
    expect((await runGit(root, ['add', '.'])).exitCode).toBe(0);
    // A staged baseline is enough: git diff compares the worktree to the index.
    writeFileSync(join(root, 'large file.txt'), `before\n${'changed line\n'.repeat(40_000)}`);
    const diff = await runGit(root, ['diff', '--', 'large file.txt']);
    expect(diff.exitCode).toBe(0);
    expect(boundedDiff(diff.stdout)).toMatchObject({ truncated: true });

    const failed = await runGit(root, ['definitely-not-a-git-subcommand']);
    expect(failed.exitCode).not.toBe(0);
    expect(hasSuccessfulGitOutput(failed)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
