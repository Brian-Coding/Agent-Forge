import { describe, expect, test } from 'bun:test';
import { isUsageSnapshotCommit, isUsageSnapshotPath, serializeUsageSnapshot } from './sync-usage';

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
});
