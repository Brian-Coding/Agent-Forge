import { expect, test } from 'bun:test';
import { enforceCoverage, parseLcovCoverage, type CoverageRequirements } from './check-coverage';

function report(records: Array<{ source: string; fn: [number, number]; lines: [number, number] }>): string {
  return records.map(record => [
    `SF:${record.source}`,
    `FNF:${record.fn[1]}`,
    `FNH:${record.fn[0]}`,
    `LF:${record.lines[1]}`,
    `LH:${record.lines[0]}`,
    'end_of_record',
  ].join('\n')).join('\n');
}

const requirements: CoverageRequirements = {
  minimumFiles: 2,
  minimumFunctionPercent: 75,
  minimumLinePercent: 70,
  requiredFiles: ['src/core.ts'],
};

test('coverage gate uses weighted executable totals and normalizes platform paths', () => {
  const totals = parseLcovCoverage(report([
    { source: 'src\\core.ts', fn: [8, 10], lines: [75, 100] },
    { source: 'src/small.ts', fn: [1, 2], lines: [2, 10] },
  ]));

  expect(totals.files).toBe(2);
  expect(totals.functionPercent).toBe(75);
  expect(totals.linePercent).toBe(70);
  expect(() => enforceCoverage(totals, requirements)).not.toThrow();
});

test('coverage gate reports independent threshold, file-count, and required-module regressions', () => {
  const totals = parseLcovCoverage(report([
    { source: 'src/other.ts', fn: [1, 10], lines: [1, 100] },
  ]));

  expect(() => enforceCoverage(totals, requirements)).toThrow(/production source records 1 < 2/);
  expect(() => enforceCoverage(totals, requirements)).toThrow(/weighted function coverage 10.00%/);
  expect(() => enforceCoverage(totals, requirements)).toThrow(/weighted line coverage 1.00%/);
  expect(() => enforceCoverage(totals, requirements)).toThrow(/required production records missing: src\/core.ts/);
});

test('coverage parser rejects truncated, duplicate, and internally impossible reports', () => {
  expect(() => parseLcovCoverage('SF:src/a.ts\nFNF:1')).toThrow(/not terminated/);
  expect(() => parseLcovCoverage(report([
    { source: 'src/a.ts', fn: [1, 1], lines: [1, 1] },
    { source: 'src/a.ts', fn: [1, 1], lines: [1, 1] },
  ]))).toThrow(/duplicate source record/);
  expect(() => parseLcovCoverage(report([
    { source: 'src/a.ts', fn: [2, 1], lines: [1, 1] },
  ]))).toThrow(/more hits than executable items/);
});
