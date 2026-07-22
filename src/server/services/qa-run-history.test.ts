import { describe, expect, test } from 'bun:test';
import type { QaRunInfo, QaRunStatus } from '../../shared/protocol';
import { appendQaRunHistory, compactQaRunHistory } from './qa-run-history';

function run(id: string, status: QaRunStatus): QaRunInfo {
  return {
    id,
    sourceAgentId: 'source',
    prompt: `test ${id}`,
    status,
    browserSessionId: `qa-${id}`,
    createdAt: Number(id.replace(/\D/g, '')) || 0,
  };
}

describe('appendQaRunHistory', () => {
  test('caps terminal history while retaining chronological order', () => {
    const existing = [run('1', 'completed'), run('2', 'failed'), run('3', 'completed')];
    expect(appendQaRunHistory(existing, run('4', 'completed'), 3).map(item => item.id))
      .toEqual(['2', '3', '4']);
  });

  test('never evicts queued or running runs when the cap is full', () => {
    const existing = [run('1', 'completed'), run('2', 'running'), run('3', 'queued')];
    expect(appendQaRunHistory(existing, run('4', 'queued'), 3).map(item => item.id))
      .toEqual(['2', '3', '4']);
  });

  test('allows active runs to temporarily exceed the terminal-history cap', () => {
    const existing = [run('1', 'running'), run('2', 'queued')];
    expect(appendQaRunHistory(existing, run('3', 'queued'), 2).map(item => item.id))
      .toEqual(['1', '2', '3']);
  });

  test('re-applies the cap as queued runs become terminal', () => {
    const runs = [run('1', 'completed'), run('2', 'completed'), run('3', 'running'), run('4', 'queued')];
    expect(compactQaRunHistory(runs, 3).map(item => item.id)).toEqual(['2', '3', '4']);
    runs[2] = run('3', 'completed');
    expect(compactQaRunHistory(runs, 3).map(item => item.id)).toEqual(['2', '3', '4']);
  });
});
