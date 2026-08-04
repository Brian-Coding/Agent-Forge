import { expect, test } from 'bun:test';
import {
  createInactivityWatchdog,
  observeTurnOutputEvent,
  parseOptionalInactivityTimeout,
  resolveTurnFinalization,
} from './chat-turn-lifecycle';

test('long-running turns have no implicit inactivity limit', () => {
  expect(parseOptionalInactivityTimeout(undefined)).toBeNull();
  expect(parseOptionalInactivityTimeout('')).toBeNull();
  expect(parseOptionalInactivityTimeout('0')).toBeNull();
  expect(parseOptionalInactivityTimeout('not-a-number')).toBeNull();
});

test('an inactivity limit is honored only when explicitly configured', () => {
  expect(parseOptionalInactivityTimeout('900000')).toBe(900000);
  expect(parseOptionalInactivityTimeout(' 3600000 ')).toBe(3600000);
});

test('the inactivity watchdog is disabled by default', () => {
  let scheduled = false;
  const watchdog = createInactivityWatchdog({
    timeoutMs: null,
    onTimeout() {
      throw new Error('disabled watchdog fired');
    },
    scheduleInterval() {
      scheduled = true;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
  });

  watchdog.start();
  expect(scheduled).toBeFalse();
});

test('every liveness touch gives a configured watchdog a fresh full window', () => {
  let clock = 0;
  let tick: (() => void) | null = null;
  let timeouts = 0;
  const watchdog = createInactivityWatchdog({
    timeoutMs: 100,
    intervalMs: 10,
    now: () => clock,
    onTimeout: () => { timeouts++; },
    scheduleInterval(callback) {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearScheduledInterval() {},
  });

  watchdog.start();
  clock = 90;
  tick!();
  expect(timeouts).toBe(0);

  watchdog.touch(); // Represents any valid raw or normalized provider event.
  clock = 180;
  tick!();
  expect(timeouts).toBe(0);

  clock = 191;
  tick!();
  tick!();
  expect(timeouts).toBe(1);
});

test('numeric interval handle zero is still tracked and cleared exactly once', () => {
  let scheduled = 0;
  const cleared: number[] = [];
  const watchdog = createInactivityWatchdog({
    timeoutMs: 100,
    onTimeout() {},
    scheduleInterval() {
      scheduled++;
      return 0;
    },
    clearScheduledInterval(handle) {
      cleared.push(handle as number);
    },
  });

  watchdog.start();
  watchdog.start();
  watchdog.stop();

  expect(scheduled).toBe(1);
  expect(cleared).toEqual([0]);
});

test('a stopped turn with partial progress persists the progress and marker', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: 'Implemented the first safe batch.',
    lastPersistedResult: null,
    abortReason: 'user',
  })).toEqual({
    assistantText: 'Implemented the first safe batch.\n\n[Stopped by user]',
    systemText: null,
  });
});

test('a stopped turn with no provider text still produces a durable marker', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: null,
    lastPersistedResult: null,
    abortReason: 'system',
  })).toEqual({
    assistantText: null,
    systemText: '[Stopped by system]',
  });
});

test('a configured inactivity timeout always leaves a durable terminal record', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: null,
    lastPersistedResult: null,
    abortReason: 'timeout',
  })).toEqual({
    assistantText: null,
    systemText: '[Stopped: configured inactivity limit reached]',
  });
});

test('a timeout preserves a complete agent message but never reasoning text', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: 'Verified work completed before the interruption.',
    lastPersistedResult: null,
    abortReason: 'timeout',
  })).toEqual({
    assistantText: 'Verified work completed before the interruption.\n\n[Stopped: configured inactivity limit reached]',
    systemText: null,
  });

  // Reasoning is deliberately absent from this reducer's inputs. Without a
  // complete assistant snapshot, only the stop marker may become durable.
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: null,
    lastPersistedResult: null,
    abortReason: 'timeout',
  }).assistantText).toBeNull();
});

test('a timeout after a persisted goal checkpoint adds only the stop marker', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: 'Checkpoint already shown.',
    lastAssistantSnapshot: null,
    lastPersistedResult: 'Checkpoint already shown.',
    abortReason: 'timeout',
  })).toEqual({
    assistantText: null,
    systemText: '[Stopped: configured inactivity limit reached]',
  });
});

test('a process-level result does not duplicate an already persisted checkpoint', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: 'Goal checkpoint complete.',
    lastAssistantSnapshot: null,
    lastPersistedResult: 'Goal checkpoint complete.',
  })).toEqual({
    assistantText: null,
    systemText: null,
  });
});

test('a distinct final result after a checkpoint is still persisted', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: 'Final verified report.',
    lastAssistantSnapshot: null,
    lastPersistedResult: 'Earlier goal checkpoint.',
  })).toEqual({
    assistantText: 'Final verified report.',
    systemText: null,
  });
});

test('provider errors and empty exits cannot disappear silently', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: null,
    lastPersistedResult: null,
    errorMessage: 'CLI transport closed unexpectedly',
  }).systemText).toBe('Agent run failed: CLI transport closed unexpectedly');

  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: null,
    lastPersistedResult: null,
  }).systemText).toBe('Agent run ended without returning a response.');
});

test('a later goal-continuation failure is persisted after an earlier checkpoint', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: 'Earlier goal checkpoint.',
    lastAssistantSnapshot: null,
    lastPersistedResult: 'Earlier goal checkpoint.',
    errorMessage: 'continuation exited with code 1',
  })).toEqual({
    assistantText: null,
    systemText: 'Agent run failed: continuation exited with code 1',
  });
});

test('an explicitly persisted adapter error is not duplicated during finalization', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: null,
    lastPersistedResult: null,
    errorMessage: 'transport failed',
    persistedSystemMessages: ['Agent run failed: transport failed'],
  })).toEqual({
    assistantText: null,
    systemText: null,
  });
});

test('a successful provider result clears an earlier recoverable stream error', () => {
  const state = {
    lastResultEmitted: null as string | null,
    lastAssistantSnapshot: null as string | null,
    lastErrorMessage: null as string | null,
  };

  observeTurnOutputEvent(state, {
    type: 'error',
    message: 'temporary transport retry',
  });
  expect(state.lastErrorMessage).toBe('temporary transport retry');

  const observation = observeTurnOutputEvent(state, {
    type: 'result',
    text: 'Recovered and completed.',
    checkpoint: true,
  });

  expect(observation.checkpointText).toBe('Recovered and completed.');
  expect(state.lastErrorMessage).toBeNull();
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: state.lastResultEmitted,
    lastAssistantSnapshot: state.lastAssistantSnapshot,
    lastPersistedResult: 'Recovered and completed.',
    errorMessage: state.lastErrorMessage,
  })).toEqual({
    assistantText: null,
    systemText: null,
  });
});

test('a terminal error arriving after a complete assistant snapshot preserves both facts', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: 'Partial final output.',
    lastPersistedResult: null,
    errorMessage: 'process exited with code 1',
  })).toEqual({
    assistantText: 'Partial final output.',
    systemText: 'Agent run failed: process exited with code 1',
  });
});

test('a complete assistant snapshot survives a missing provider turn boundary', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: 'Completed output before the stream closed.',
    lastPersistedResult: null,
  })).toEqual({
    assistantText: 'Completed output before the stream closed.',
    systemText: null,
  });
});

test('a stopped failed turn preserves both the failure and stop reason', () => {
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: null,
    lastPersistedResult: null,
    abortReason: 'user',
    errorMessage: 'termination transport failed',
  })).toEqual({
    assistantText: null,
    systemText: 'Agent run failed: termination transport failed\n\n[Stopped by user]',
  });
});
