import { describe, expect, test } from 'bun:test';
import {
  assertSafeUsageSyncBranch,
  isUsageSnapshotCommit,
  isUsageSnapshotPath,
  serializeUsageSnapshot,
  validateUsageShardValue,
} from './sync-usage';

describe('usage snapshot synchronization safety', () => {
  test('serializes compact, reviewable, valid JSON', () => {
    const events = [
      { id: 'one', inputTokens: 10 },
      { id: 'two', outputTokens: 20 },
    ];
    const serialized = serializeUsageSnapshot(events);

    expect(serialized.split('\n')).toHaveLength(5);
    expect(JSON.parse(serialized)).toEqual(events);
  });

  test('recognizes only machine usage snapshot paths', () => {
    expect(isUsageSnapshotPath('.agent-forge-sync/usage/machine-a.json')).toBe(true);
    expect(isUsageSnapshotPath('.agent-forge-sync\\usage\\work-mac.json')).toBe(true);
    expect(isUsageSnapshotPath('.agent-forge-sync/usage/../data.json')).toBe(false);
    expect(isUsageSnapshotPath('src/server/index.ts')).toBe(false);
  });

  test('permits ahead commits only when their subject and files are usage snapshots', () => {
    expect(isUsageSnapshotCommit(
      'chore(usage): snapshot machine-a',
      ['.agent-forge-sync/usage/machine-a.json'],
    )).toBe(true);
    expect(isUsageSnapshotCommit('feat: unrelated work', ['.agent-forge-sync/usage/machine-a.json'])).toBe(false);
    expect(isUsageSnapshotCommit('chore(usage): snapshot machine-a', ['src/server/index.ts'])).toBe(false);
    expect(isUsageSnapshotCommit('chore(usage): snapshot machine-a', [])).toBe(false);
  });

  test('rejects corrupt usage counters and accepts a complete bounded event', () => {
    const valid = [{
      id: 'event-1',
      timestamp: 1,
      agentId: 'agent-1',
      provider: 'codex',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0,
      turns: 1,
    }];
    expect(validateUsageShardValue(valid)).toMatchObject({ eventCount: 1, totalTokens: 15 });
    for (const invalid of [
      [{ ...valid[0], inputTokens: Number.NaN }],
      [{ ...valid[0], outputTokens: -1 }],
      [{ ...valid[0], provider: 'unknown' }],
      [{ ...valid[0], agentId: '' }],
      [null],
    ]) {
      expect(() => validateUsageShardValue(invalid)).toThrow('Usage event');
    }
  });

  test('master is blocked whenever local or remote develop exists', () => {
    expect(() => assertSafeUsageSyncBranch('master', ['master', 'develop'])).toThrow('develop branch exists');
    expect(() => assertSafeUsageSyncBranch('master', ['master', 'origin/develop'])).toThrow('develop branch exists');
    expect(() => assertSafeUsageSyncBranch('develop', ['master', 'develop'])).not.toThrow();
    expect(() => assertSafeUsageSyncBranch('feature/usage', ['origin/develop'])).not.toThrow();
  });
});
