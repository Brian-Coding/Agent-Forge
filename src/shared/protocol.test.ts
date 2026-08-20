import { expect, test } from 'bun:test';
import { migrateAgentRecord } from './protocol';

test('migrateAgentRecord preserves model-bound sessions', () => {
  const record = migrateAgentRecord({
    id: 'a1',
    provider: 'claude',
    model: 'claude-fable-5',
    currentSessionId: 'session-1',
    currentSessionProvider: 'claude',
    currentSessionModel: 'claude-fable-5',
  });

  expect(record.currentSessionId).toBe('session-1');
  expect(record.currentSessionProvider).toBe('claude');
  expect(record.currentSessionModel).toBe('claude-fable-5');
});

test('migrateAgentRecord marks pre-model-binding sessions unsafe to resume', () => {
  const record = migrateAgentRecord({
    id: 'a1',
    provider: 'claude',
    model: 'claude-fable-5',
    currentSessionId: 'session-1',
    currentSessionProvider: 'claude',
  });

  expect(record.currentSessionId).toBe('session-1');
  expect(record.currentSessionProvider).toBe('claude');
  expect(record.currentSessionModel).toBeNull();
});

test('migrateAgentRecord preserves a well-formed modelMismatch', () => {
  const record = migrateAgentRecord({
    id: 'a1',
    modelMismatch: { requested: 'claude-fable-5', ran: 'claude-opus-4-8', at: 1234 },
  });
  expect(record.modelMismatch).toEqual({ requested: 'claude-fable-5', ran: 'claude-opus-4-8', at: 1234 });
});

test('migrateAgentRecord collapses malformed modelMismatch to null so sends cannot be permanently wedged', () => {
  expect(migrateAgentRecord({ id: 'a1' }).modelMismatch).toBeNull();
  expect(migrateAgentRecord({ id: 'a1', modelMismatch: 'garbage' }).modelMismatch).toBeNull();
  expect(migrateAgentRecord({ id: 'a1', modelMismatch: { requested: '', ran: 'x' } }).modelMismatch).toBeNull();
  expect(migrateAgentRecord({ id: 'a1', modelMismatch: { requested: 'x' } }).modelMismatch).toBeNull();
});

test('migrateAgentRecord preserves only well-formed terminal turn outcomes', () => {
  expect(migrateAgentRecord({
    id: 'agent-1',
    lastTurnOutcome: { status: 'failed', at: 1234, detail: 'CLI exited' },
  }).lastTurnOutcome).toEqual({ status: 'failed', at: 1234, detail: 'CLI exited' });

  expect(migrateAgentRecord({
    id: 'agent-2',
    lastTurnOutcome: { status: 'still-retrying', at: 'yesterday' },
  }).lastTurnOutcome).toBeNull();
});

test('migrateAgentRecord clears sessions whose id or provider ownership is malformed', () => {
  for (const candidate of [
    { currentSessionId: 42, currentSessionProvider: 'claude', currentSessionModel: 'model' },
    { currentSessionId: 'session', currentSessionProvider: 'unknown', currentSessionModel: 'model' },
    { currentSessionId: '', currentSessionProvider: 'codex', currentSessionModel: 'model' },
  ]) {
    expect(migrateAgentRecord({ id: 'a1', ...candidate })).toMatchObject({
      currentSessionId: null,
      currentSessionProvider: null,
      currentSessionModel: null,
    });
  }
});

test('migrateAgentRecord replaces non-finite mismatch timestamps and is idempotent', () => {
  const once = migrateAgentRecord({
    id: 'a1',
    modelMismatch: { requested: 'requested', ran: 'actual', at: Number.POSITIVE_INFINITY },
  });
  expect(Number.isFinite(once.modelMismatch?.at)).toBe(true);
  expect(migrateAgentRecord(once)).toEqual(once);
});

test('migrateAgentRecord never throws across representative hostile persisted values', () => {
  const hostileValues: any[] = [
    null,
    undefined,
    false,
    0,
    '',
    [],
    {},
    { sessionIds: null },
    { sessionIds: [] },
    { sessionIds: { claude: 7, codex: {} } },
    { modelMismatch: Object.create(null) },
    { lastTurnOutcome: { status: 'completed', at: Number.NaN } },
    { currentSessionId: {}, currentSessionProvider: ['claude'] },
  ];
  for (const value of hostileValues) {
    expect(() => migrateAgentRecord(value)).not.toThrow();
  }
});
