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
