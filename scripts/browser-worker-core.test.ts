import { describe, expect, test } from 'bun:test';
import {
  browserSessionKey,
  compileEvaluationScript,
  normalizeBrowserSessionId,
} from './browser-worker-core.mjs';

describe('browser worker core', () => {
  test('keeps browser sessions isolated inside one workspace', () => {
    expect(browserSessionKey('workspace-1', 'qa-run-1')).not.toBe(
      browserSessionKey('workspace-1', 'atlas-run-1'),
    );
    expect(browserSessionKey('workspace-1', 'qa-run-1')).not.toBe(
      browserSessionKey('workspace-2', 'qa-run-1'),
    );
  });

  test('validates session identifiers', () => {
    expect(normalizeBrowserSessionId(undefined)).toBe('default');
    expect(normalizeBrowserSessionId('qa_run-123')).toBe('qa_run-123');
    expect(() => normalizeBrowserSessionId('../escape')).toThrow();
  });

  test('evaluates expressions and statement bodies', async () => {
    expect(await eval(compileEvaluationScript('1 + 2'))).toBe(3);
    expect(await eval(compileEvaluationScript('const value = 4; return value * 2;'))).toBe(8);
  });

  test('a throwing expression executes exactly once', async () => {
    (globalThis as any).__agentForgeEvaluateCount = 0;
    const compiled = compileEvaluationScript(
      `(() => { globalThis.__agentForgeEvaluateCount += 1; throw new Error('expected'); })()`,
    );

    await expect(eval(compiled)).rejects.toThrow('expected');
    expect((globalThis as any).__agentForgeEvaluateCount).toBe(1);
    delete (globalThis as any).__agentForgeEvaluateCount;
  });
});

