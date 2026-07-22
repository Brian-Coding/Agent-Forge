import { describe, expect, test } from 'bun:test';
import { formatQaReport, parseQaResult, QA_RESULT_END, QA_RESULT_START } from './qa-result';

function report(value: Record<string, unknown>): string {
  return `Narrative report\n\n${QA_RESULT_START}\n${JSON.stringify(value)}\n${QA_RESULT_END}`;
}

function validPass(runId = 'run-1'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId,
    verdict: 'pass',
    summary: 'Primary flow works.',
    assertions: [{ id: 'assert.home', name: 'Home renders', status: 'passed', evidenceIds: ['shot.home', 'console.clean'], atlasSurfaceIds: ['surface.home'] }],
    evidence: [
      { id: 'shot.home', kind: 'screenshot', label: 'Home', ref: 'C:/artifacts/home.png' },
      { id: 'console.clean', kind: 'console', label: 'Console was clean', detail: '0 errors, 0 warnings' },
    ],
    findings: [],
    atlasSurfaceIds: ['surface.home'],
  };
}

describe('structured QA results', () => {
  test('accepts an evidence-backed PASS', () => {
    const parsed = parseQaResult(report(validPass()), 'run-1');
    expect(parsed.authoritative).toBe(true);
    expect(parsed.verdict).toBe('pass');
    expect(parsed.envelope?.assertions).toHaveLength(1);
  });

  test('downgrades prose-only output to INCONCLUSIVE', () => {
    const parsed = parseQaResult('Everything looked fine.', 'run-1');
    expect(parsed.authoritative).toBe(false);
    expect(parsed.verdict).toBe('inconclusive');
    expect(formatQaReport(parsed)).toStartWith('⚪ INCONCLUSIVE');
  });

  test('rejects PASS without console evidence', () => {
    const value = validPass();
    value.evidence = [(value.evidence as any[])[0]];
    const parsed = parseQaResult(report(value), 'run-1');
    expect(parsed.verdict).toBe('inconclusive');
    expect(parsed.validationErrors.some(error => error.includes('console evidence'))).toBe(true);
  });

  test('rejects a mismatched run ID', () => {
    const parsed = parseQaResult(report(validPass('wrong-run')), 'run-1');
    expect(parsed.authoritative).toBe(false);
    expect(parsed.validationErrors).toContain('runId does not match the executing QA run');
  });

  test('accepts an evidenced failure', () => {
    const value = validPass();
    value.verdict = 'fail';
    value.summary = 'Save failed.';
    value.assertions = [{ id: 'assert.save', name: 'Save succeeds', status: 'failed', evidenceIds: ['shot.home'] }];
    value.findings = [{ id: 'finding.save', severity: 'major', title: 'Save is broken', details: 'Clicking Save throws.', evidenceIds: ['shot.home'] }];
    const parsed = parseQaResult(report(value), 'run-1');
    expect(parsed.authoritative).toBe(true);
    expect(parsed.verdict).toBe('fail');
  });

  test('rejects assertions and findings that do not cite evidence', () => {
    const value = validPass();
    value.verdict = 'fail';
    value.assertions = [{ id: 'assert.save', name: 'Save succeeds', status: 'failed', evidenceIds: [] }];
    value.findings = [{ id: 'finding.save', severity: 'major', title: 'Save is broken', details: 'Clicking Save throws.', evidenceIds: [] }];
    const parsed = parseQaResult(report(value), 'run-1');
    expect(parsed.authoritative).toBe(false);
    expect(parsed.validationErrors.some(error => error.includes('requires evidence'))).toBe(true);
  });

  test('rejects contradictory WARNINGS results', () => {
    const value = validPass();
    value.verdict = 'warnings';
    value.assertions = [{ id: 'assert.save', name: 'Save succeeds', status: 'failed', evidenceIds: ['shot.home'] }];
    value.findings = [{ id: 'finding.save', severity: 'major', title: 'Save is broken', details: 'Clicking Save throws.', evidenceIds: ['shot.home'] }];
    const parsed = parseQaResult(report(value), 'run-1');
    expect(parsed.authoritative).toBe(false);
    expect(parsed.validationErrors).toContain('WARNINGS cannot include a failed assertion');
  });

  test('rejects multiple machine envelopes as ambiguous', () => {
    const once = report(validPass());
    const parsed = parseQaResult(`${once}\n\n${once}`, 'run-1');
    expect(parsed.authoritative).toBe(false);
    expect(parsed.validationErrors[0]).toContain('exactly one structured result envelope');
  });

  test('caps the persisted narrative size', () => {
    const formatted = formatQaReport({ verdict: 'pass', summary: 'Done.', reportBody: 'x'.repeat(60_000) });
    expect(formatted.length).toBeLessThan(51_000);
    expect(formatted).toContain('QA narrative truncated by Agent Forge');
  });
});
