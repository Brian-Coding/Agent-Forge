import { describe, expect, test } from 'bun:test';
import {
  browserSessionKey,
  compileEvaluationScript,
  normalizeBrowserSessionId,
  singleFlight,
  withOperationTimeout,
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

  test('single-flight coalesces same-key creation but preserves cross-key parallelism', async () => {
    const inFlight = new Map<string, Promise<number>>();
    let sameKeyCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const operation = () => singleFlight(inFlight, 'same', async () => {
      sameKeyCalls++;
      await gate;
      return 42;
    });
    const first = operation();
    const second = operation();
    const other = singleFlight(inFlight, 'other', async () => 7);

    expect(first).toBe(second);
    expect(await other).toBe(7);
    release();
    expect(await Promise.all([first, second])).toEqual([42, 42]);
    expect(sameKeyCalls).toBe(1);
  });

  test('single-flight rejection does not poison a later retry', async () => {
    const inFlight = new Map<string, Promise<string>>();
    let attempts = 0;
    const run = () => singleFlight(inFlight, 'resource', async () => {
      attempts++;
      if (attempts === 1) throw new Error('launch failed');
      return 'ready';
    });

    await expect(run()).rejects.toThrow('launch failed');
    expect(await run()).toBe('ready');
    expect(attempts).toBe(2);
  });

  test('operation timeout rejects without waiting for hung cleanup', async () => {
    const startedAt = Date.now();
    let cleanupCalls = 0;
    await expect(withOperationTimeout(
      new Promise(() => {}),
      20,
      'injected operation',
      () => {
        cleanupCalls++;
        return new Promise(() => {});
      },
    )).rejects.toThrow('injected operation timed out after 20ms');
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(cleanupCalls).toBe(1);
  });
});

