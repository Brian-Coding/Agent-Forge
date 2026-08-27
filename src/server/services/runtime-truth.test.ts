import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { healthContainsSecretLikeValue } from '../../shared/runtime-health';
import {
  CRITICAL_RUNTIME_FILES,
  createRuntimeTruth,
  parseCliVersion,
  versionProbeEnv,
} from './runtime-truth';

const files = Object.fromEntries(
  CRITICAL_RUNTIME_FILES.map((relative, index) => [relative, `module-${index}\n`]),
);

function truth(overrides: Parameters<typeof createRuntimeTruth>[0] = {}) {
  return createRuntimeTruth({
    now: () => 1_700_000_000_000,
    serverSessionId: 'session-test',
    startedAt: 1_700_000_000_000,
    bunVersion: '1.3.14',
    sourceRoot: 'C:/repo',
    fileExists: path => Object.keys(files).some(relative => path.endsWith(relative.replaceAll('/', '\\')) || path.endsWith(relative)),
    readFile: path => {
      const relative = CRITICAL_RUNTIME_FILES.find(name => path.endsWith(name.replaceAll('/', '\\')) || path.endsWith(name));
      if (!relative) throw new Error(`unexpected read ${path}`);
      return files[relative]!;
    },
    readGitIdentity: () => ({ commit: 'abc1234def', dirty: true }),
    probeProviders: () => ([
      { provider: 'claude', cliName: 'claude', available: true, cliVersion: '2.1.241' },
      { provider: 'codex', cliName: 'codex', available: true, cliVersion: '0.70.0' },
    ]),
    ...overrides,
  });
}

test('a matching on-disk fingerprint is current and auth stays unprobed', async () => {
  const service = truth();
  const health = await service.getHealth();
  expect(health.runtime.drift).toBe('current');
  expect(health.runtime.onDiskFingerprint).toBeDefined();
  expect(health.runtime.runningFingerprint).toBe(health.runtime.onDiskFingerprint!);
  expect(health.runtime.bunVersion).toBe('1.3.14');
  expect(health.runtime.serverSessionId).toBe('session-test');
  expect(health.runtime.source).toEqual({ commit: 'abc1234def', dirty: true });
  expect(health.runtime.providers.map(provider => provider.cliVersion)).toEqual(['2.1.241', '0.70.0']);
  expect(health.auth.every(snapshot => snapshot.reasonCode === 'not-probed')).toBe(true);
  expect(healthContainsSecretLikeValue(health)).toBe(false);
});

test('a deliberately stale on-disk fingerprint is restart-required without restarting anything', async () => {
  let diskGeneration = 0;
  const service = truth({
    readFile: path => {
      const relative = CRITICAL_RUNTIME_FILES.find(name => path.endsWith(name.replaceAll('/', '\\')) || path.endsWith(name));
      return `${files[relative!]}\n${diskGeneration}`;
    },
  });
  await service.captureStartup();
  diskGeneration = 1;
  const health = await service.getHealth();
  expect(health.runtime.drift).toBe('restart-required');
  expect(health.runtime.runningFingerprint).not.toBe(health.runtime.onDiskFingerprint);
  expect(service.peekCompact()?.drift).toBe('restart-required');
});

test('a missing critical file makes drift unknown instead of claiming current', async () => {
  const service = truth({
    fileExists: path => !path.endsWith('chat.service.ts') && (
      Object.keys(files).some(relative => path.endsWith(relative.replaceAll('/', '\\')) || path.endsWith(relative))
    ),
  });
  const health = await service.getHealth();
  expect(health.runtime.drift).toBe('unknown');
});

test('health output does not echo seeded secrets from the process environment', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-seed-xyz';
  try {
    const health = await truth().getHealth();
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain('sk-ant-secret-seed-xyz');
    expect(serialized).not.toContain('ANTHROPIC_API_KEY');
    expect(healthContainsSecretLikeValue(health)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('version probe env keeps PATH and drops credential names', () => {
  const env = versionProbeEnv({
    PATH: 'C:\\bin',
    ANTHROPIC_API_KEY: 'sk-ant-secret-seed-xyz',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
    USERPROFILE: 'C:\\Users\\dev',
  });
  expect(env.PATH).toBe('C:\\bin');
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(JSON.stringify(env)).not.toContain('sk-ant-secret-seed-xyz');
});

test('parseCliVersion reads the first qualified version token', () => {
  expect(parseCliVersion('2.1.241 (Claude Code)')).toBe('2.1.241');
  expect(parseCliVersion('codex-cli 0.70.0')).toBe('0.70.0');
  expect(parseCliVersion('not a version')).toBeUndefined();
});

test('runtime truth source never owns server lifecycle or credential files', () => {
  const source = readFileSync(join(import.meta.dir, 'runtime-truth.ts'), 'utf8');
  expect(source).not.toContain('shutdown');
  expect(source).not.toContain('process-lock');
  expect(source).not.toContain('killProcessTree');
  expect(source).not.toContain('acquireProcessLock');
  expect(source).not.toContain('.credentials.json');
});
