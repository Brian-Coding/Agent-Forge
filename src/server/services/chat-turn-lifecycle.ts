import type { AgentEvent } from '../agents/events';

export type TurnAbortReason = 'user' | 'timeout' | 'system';

export type InactivityIntervalHandle = ReturnType<typeof setInterval> | number;

export interface TurnFinalizationInput {
  provider: 'claude' | 'codex';
  accumulatedText: string;
  lastResultEmitted: string | null;
  lastAssistantSnapshot: string | null;
  lastPersistedResult: string | null;
  abortReason?: TurnAbortReason;
  errorMessage?: string | null;
  persistedSystemMessages?: readonly string[];
}

export interface TurnFinalization {
  assistantText: string | null;
  systemText: string | null;
}

export interface InactivityWatchdog {
  touch(): void;
  start(): void;
  stop(): void;
}

export interface InactivityWatchdogOptions {
  timeoutMs: number | null;
  onTimeout(): void;
  now?: () => number;
  intervalMs?: number;
  scheduleInterval?: (callback: () => void, ms: number) => InactivityIntervalHandle;
  clearScheduledInterval?: (handle: InactivityIntervalHandle) => void;
}

export interface TurnOutputState {
  lastResultEmitted: string | null;
  lastAssistantSnapshot: string | null;
  lastErrorMessage: string | null;
}

export interface TurnOutputObservation {
  checkpointText: string | null;
}

function normalized(text: string | null | undefined): string {
  return (text ?? '').trim();
}

/**
 * Long-running turns are unlimited by default. Operators can still opt into an
 * inactivity limit for unattended environments by setting a positive number
 * of milliseconds explicitly.
 */
export function parseOptionalInactivityTimeout(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Apply the provider-output events that affect terminal chat persistence.
 * A successful result supersedes an earlier recoverable stream error; a later
 * terminal error will arrive as a new error event and replace it again.
 */
export function observeTurnOutputEvent(
  state: TurnOutputState,
  event: Extract<AgentEvent, { type: 'assistant-snapshot' | 'result' | 'error' }>,
): TurnOutputObservation {
  if (event.type === 'assistant-snapshot') {
    if (event.text.trim()) state.lastAssistantSnapshot = event.text;
    return { checkpointText: null };
  }

  if (event.type === 'result') {
    state.lastResultEmitted = event.text;
    state.lastErrorMessage = null;
    return { checkpointText: event.checkpoint ? event.text : null };
  }

  state.lastErrorMessage = event.message;
  return { checkpointText: null };
}

export function abortMarker(reason: TurnAbortReason): string {
  if (reason === 'timeout') return '[Stopped: configured inactivity limit reached]';
  if (reason === 'system') return '[Stopped by system]';
  return '[Stopped by user]';
}

/**
 * A one-shot inactivity limit used only when the operator explicitly enables
 * one. `touch()` is intentionally provider-agnostic: both normalized events
 * and future/raw valid events refresh the same clock.
 */
export function createInactivityWatchdog(
  options: InactivityWatchdogOptions,
): InactivityWatchdog {
  const now = options.now ?? Date.now;
  const schedule = options.scheduleInterval
    ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const clear = options.clearScheduledInterval
    ?? ((handle: InactivityIntervalHandle) => clearInterval(handle));
  const intervalMs = options.intervalMs ?? 30_000;
  let lastActivity = now();
  let timer: InactivityIntervalHandle | null = null;
  let triggered = false;

  return {
    touch() {
      if (!triggered) lastActivity = now();
    },
    start() {
      if (timer !== null || options.timeoutMs === null) return;
      timer = schedule(() => {
        if (triggered || options.timeoutMs === null) return;
        if (now() - lastActivity <= options.timeoutMs) return;
        triggered = true;
        options.onTimeout();
      }, intervalMs);
    },
    stop() {
      if (timer !== null) clear(timer);
      timer = null;
    },
  };
}

/**
 * Resolve the durable terminal output for a provider process.
 *
 * Codex checkpoints each completed CLI turn before the long-lived process
 * exits. A matching process-level result is therefore a duplicate, while a
 * later distinct result remains worth persisting. Aborted turns always produce
 * a durable marker, even when the provider emitted no text at all.
 */
export function resolveTurnFinalization(input: TurnFinalizationInput): TurnFinalization {
  const streamed = normalized(input.accumulatedText);
  const result = normalized(input.lastResultEmitted);
  const assistantSnapshot = normalized(input.lastAssistantSnapshot);
  const persisted = normalized(input.lastPersistedResult);

  let candidate = input.provider === 'codex' && result
    ? result
    : (streamed.length >= result.length ? streamed : result);

  if (candidate && candidate === persisted) candidate = '';
  if (!candidate && assistantSnapshot && assistantSnapshot !== persisted) {
    candidate = assistantSnapshot;
  }

  const error = normalized(input.errorMessage);
  const errorAlreadyPersisted = !!error && (input.persistedSystemMessages ?? [])
    .some(message => normalized(message) === error || normalized(message).endsWith(error));
  const errorSystemText = error && !errorAlreadyPersisted
    ? `Agent run failed: ${error}`
    : null;

  if (input.abortReason) {
    const marker = abortMarker(input.abortReason);
    return candidate
      ? { assistantText: `${candidate}\n\n${marker}`, systemText: errorSystemText }
      : {
          assistantText: null,
          systemText: errorSystemText ? `${errorSystemText}\n\n${marker}` : marker,
        };
  }

  if (candidate) return { assistantText: candidate, systemText: errorSystemText };
  if (errorSystemText) return { assistantText: null, systemText: errorSystemText };
  if (error && errorAlreadyPersisted) return { assistantText: null, systemText: null };

  if (persisted) return { assistantText: null, systemText: null };

  return {
    assistantText: null,
    systemText: 'Agent run ended without returning a response.',
  };
}
