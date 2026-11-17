import { expect, test } from 'bun:test';
import { normalizeReportedUsage, reportedSum } from './reported-usage';

test('usage persistence drops malformed counters without manufacturing a free run', () => {
  expect(normalizeReportedUsage({ inputTokens: '12', outputTokens: Infinity, costUsd: -1 })).toEqual({ inputTokens: undefined, outputTokens: undefined, costUsd: undefined });
  expect(normalizeReportedUsage({ inputTokens: 12, outputTokens: 0, costUsd: 0 })).toEqual({ inputTokens: 12, outputTokens: 0, costUsd: 0 });
  expect(normalizeReportedUsage(null)).toBeUndefined();
  expect(reportedSum(undefined, undefined)).toBeUndefined();
});
