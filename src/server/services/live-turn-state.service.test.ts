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
