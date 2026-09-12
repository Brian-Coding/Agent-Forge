import { beforeEach, expect, test } from 'bun:test';
import { liveTurnStateService } from './live-turn-state.service';

beforeEach(() => liveTurnStateService.resetForTests());

test('live turn state retains bounded thought and response for reconnect hydration', () => {
  const started = liveTurnStateService.begin('agent-1', 'codex', 100);
  liveTurnStateService.appendThought('agent-1', started.turnId, 'Inspecting files', 110);
  liveTurnStateService.appendResponse('agent-1', started.turnId, 'Working answer', 120);

  const snapshot = liveTurnStateService.get('agent-1');
  expect(snapshot?.thought).toBe('Inspecting files');
  expect(snapshot?.response).toBe('Working answer');
  expect(snapshot?.lastProviderEventAt).toBe(120);
  expect(snapshot?.revision).toBeGreaterThan(started.revision);
});

test('old turn teardown cannot clear a newer turn', () => {
  const oldTurn = liveTurnStateService.begin('agent-1', 'codex', 100);
  const newTurn = liveTurnStateService.begin('agent-1', 'claude', 200);

  expect(liveTurnStateService.finalize('agent-1', oldTurn.turnId, 300)).toBeNull();
  expect(liveTurnStateService.get('agent-1')?.turnId).toBe(newTurn.turnId);
  expect(liveTurnStateService.get('agent-1')?.active).toBe(true);
});

test('provider deltas retain intentional repeated text', () => {
  const turn = liveTurnStateService.begin('agent-1', 'claude', 100);
  liveTurnStateService.appendThought('agent-1', turn.turnId, 'the ');
  liveTurnStateService.appendThought('agent-1', turn.turnId, 'the ');
  expect(liveTurnStateService.get('agent-1')?.thought).toBe('the the ');
});

test('an interrupted goal continuation remains stopped despite late JSONL and tool events', () => {
  const turn = liveTurnStateService.begin('planet', 'codex', 100);
  const observe = (state: Parameters<typeof liveTurnStateService.observeProviderTurn>[2]) =>
    liveTurnStateService.observeProviderTurn('planet', turn.turnId, state);
  observe({ status: 'completed', source: 'jsonl', at: 410 });
  observe({ status: 'completed', source: 'rollout', id: 'repair', at: 400 });
  observe({ status: 'running', source: 'rollout', id: 'continuation', at: 420 });
  observe({ status: 'stopped', source: 'rollout', id: 'continuation', at: 425 });
  expect(observe({ status: 'running', source: 'jsonl', at: 430 })).toBeNull();
  expect(observe({ status: 'completed', source: 'rollout', id: 'repair', at: 400 })).toBeNull();
  expect(observe({ status: 'running', source: 'rollout', id: 'continuation', at: 440 })).toBeNull();
  liveTurnStateService.clearActivity('planet', turn.turnId, 'tool', 450);
  liveTurnStateService.touch('planet', turn.turnId, 460);
  expect(liveTurnStateService.get('planet')).toMatchObject({
    active: true, providerTurn: { status: 'stopped', id: 'continuation', at: 425 },
  });
  const snapshot = liveTurnStateService.get('planet')!;
  snapshot.providerTurn!.status = 'running';
  expect(liveTurnStateService.get('planet')?.providerTurn?.status).toBe('stopped');
  observe({ status: 'running', source: 'rollout', id: 'next', at: 500 });
  expect(liveTurnStateService.get('planet')?.providerTurn?.status).toBe('running');
  liveTurnStateService.finalize('planet', turn.turnId, 510);
  expect(observe({ status: 'running', source: 'rollout', id: 'late', at: 520 })).toBeNull();
});

test('definitive JSONL failure survives an older rollout and resets for a new attempt', () => {
  const turn = liveTurnStateService.begin('planet', 'codex', 100);
  liveTurnStateService.observeProviderTurn('planet', turn.turnId, { status: 'running', source: 'rollout', id: 'one', at: 110 });
  liveTurnStateService.observeProviderTurn('planet', turn.turnId, { status: 'failed', source: 'jsonl', at: 150 });
  expect(liveTurnStateService.observeProviderTurn('planet', turn.turnId, { status: 'running', source: 'rollout', id: 'one', at: 110 })).toBeNull();
  expect(liveTurnStateService.begin('planet', 'codex', 200).providerTurn).toBeUndefined();
  expect(liveTurnStateService.observeProviderTurn('planet', turn.turnId, { status: 'completed', source: 'jsonl', at: 210 })).toBeNull();
});
