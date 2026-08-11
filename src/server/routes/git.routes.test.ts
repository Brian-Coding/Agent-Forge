import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveGitDiffTarget } from './git.routes';

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
