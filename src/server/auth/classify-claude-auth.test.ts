import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyClaudeAuthOutput, type ClaudeAuthClassification } from './classify-claude-auth';

const fixtureDirectory = join(
  import.meta.dir,
  '../../../docs/provider-compatibility/claude/fixtures/2.1.241',
);

test('Claude 2.1.241 fixtures classify to one typed state and reason code', async () => {
  const files = (await readdir(fixtureDirectory)).filter(name => name.endsWith('.json')).sort();
  expect(files.length).toBeGreaterThanOrEqual(8);

  for (const name of files) {
    const fixture = await Bun.file(join(fixtureDirectory, name)).json() as {
      id: string;
      kind?: 'auth-status' | 'turn-output';
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
      missing?: boolean;
      expected: ClaudeAuthClassification;
    };
    expect(classifyClaudeAuthOutput({
      kind: fixture.kind,
      exitCode: fixture.exitCode,
      stdout: fixture.stdout,
      stderr: fixture.stderr,
      timedOut: fixture.timedOut,
      missing: fixture.missing,
    })).toEqual(fixture.expected);
  }
});
