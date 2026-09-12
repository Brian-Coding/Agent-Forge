import type { AgentProvider, LiveTurnStateSnapshot, ProviderTurnState } from '../../shared/protocol';

const MAX_THOUGHT_CHARS = 16_000;
const MAX_RESPONSE_CHARS = 256_000;

interface LiveTurnStore {
  records: Map<string, LiveTurnStateSnapshot>;
  nextTurnId: number;
}

const store: LiveTurnStore = (globalThis as any).__liveTurnStateStore ??= {
  records: new Map<string, LiveTurnStateSnapshot>(),
  nextTurnId: 1,
};

function tail(value: string, cap: number): string {
  return value.length <= cap ? value : value.slice(value.length - cap);
}

function nextRevision(current?: LiveTurnStateSnapshot): number {
  return (current?.revision ?? 0) + 1;
}

function clone(snapshot: LiveTurnStateSnapshot): LiveTurnStateSnapshot {
  return {
    ...snapshot,
    activity: snapshot.activity ? { ...snapshot.activity } : null,
    ...(snapshot.providerTurn ? { providerTurn: { ...snapshot.providerTurn } } : {}),
  };
}

function update(
  agentId: string,
  turnId: string,
  mutate: (current: LiveTurnStateSnapshot) => void,
): LiveTurnStateSnapshot | null {
  const current = store.records.get(agentId);
  if (!current || current.turnId !== turnId) return null;
  mutate(current);
  current.revision = nextRevision(current);
  store.records.set(agentId, current);
  return clone(current);
}

export const liveTurnStateService = {
  begin(agentId: string, provider: AgentProvider, at = Date.now()): LiveTurnStateSnapshot {
    const turnId = `${at}-${store.nextTurnId++}`;
    const snapshot: LiveTurnStateSnapshot = {
      agentId,
      turnId,
      provider,
      active: true,
      phase: 'starting',
      thought: '',
      response: '',
      activity: null,
      startedAt: at,
      lastProviderEventAt: at,
      lastVisibleProgressAt: at,
      revision: 1,
    };
    store.records.set(agentId, snapshot);
    return clone(snapshot);
  },

  touch(agentId: string, turnId: string, at = Date.now()): LiveTurnStateSnapshot | null {
    return update(agentId, turnId, current => {
      current.lastProviderEventAt = at;
    });
  },

  observeProviderTurn(agentId: string, turnId: string, next: ProviderTurnState): LiveTurnStateSnapshot | null {
    const current = store.records.get(agentId);
    if (!current || current.turnId !== turnId || !current.active) return null;
    const previous = current.providerTurn;
    // The two streams arrive independently. Timestamped, identified rollout
    // boundaries win over unidentifiable JSONL boundaries, including late ones.
    // JSONL failure is definitive and may be the only terminal error signal.
    if (previous?.source === 'rollout' && next.source === 'jsonl' && next.status !== 'failed') return null;
    if (previous?.source === 'jsonl' && previous.status === 'failed' && next.at < previous.at) return null;
    if (previous?.source === next.source && next.at < previous.at) return null;
    if (previous?.id && next.id === previous.id && previous.status !== 'running' && next.status === 'running') return null;
    return update(agentId, turnId, snapshot => {
      snapshot.providerTurn = { ...next };
      snapshot.activity = null;
      if (next.status === 'running') snapshot.phase = 'working';
    });
  },

  toolCompleted(agentId: string, turnId: string, at = Date.now()): void {
    update(agentId, turnId, current => { current.lastToolCompletedAt = at; });
  },

  setPhase(
    agentId: string,
    turnId: string,
    phase: LiveTurnStateSnapshot['phase'],
    at = Date.now(),
  ): LiveTurnStateSnapshot | null {
    return update(agentId, turnId, current => {
      current.phase = phase;
      current.lastProviderEventAt = at;
    });
  },

  appendThought(agentId: string, turnId: string, text: string, at = Date.now()): LiveTurnStateSnapshot | null {
    if (!text) return update(agentId, turnId, current => {
      current.lastProviderEventAt = at;
    });
    return update(agentId, turnId, current => {
      current.thought = tail(current.thought + text, MAX_THOUGHT_CHARS);
      current.phase = 'thinking';
      current.lastProviderEventAt = at;
      current.lastVisibleProgressAt = at;
    });
  },

  appendResponse(agentId: string, turnId: string, text: string, at = Date.now()): LiveTurnStateSnapshot | null {
    if (!text) return update(agentId, turnId, current => {
      current.lastProviderEventAt = at;
    });
    return update(agentId, turnId, current => {
      current.response = tail(current.response + text, MAX_RESPONSE_CHARS);
      current.phase = 'responding';
      current.lastProviderEventAt = at;
      current.lastVisibleProgressAt = at;
    });
  },

  setActivity(
    agentId: string,
    turnId: string,
    activity: NonNullable<LiveTurnStateSnapshot['activity']>,
  ): LiveTurnStateSnapshot | null {
    return update(agentId, turnId, current => {
      current.activity = { ...activity };
      current.phase = activity.kind === 'transport' ? 'transport' : 'tool';
      current.lastProviderEventAt = activity.timestamp;
      current.lastVisibleProgressAt = activity.timestamp;
    });
  },

  clearActivity(agentId: string, turnId: string, kind?: string, at = Date.now()): LiveTurnStateSnapshot | null {
    return update(agentId, turnId, current => {
      if (!kind || current.activity?.kind === kind) current.activity = null;
      current.lastProviderEventAt = at;
      if (current.active) current.phase = current.thought ? 'thinking' : 'working';
    });
  },

  finalize(agentId: string, turnId: string, at = Date.now()): LiveTurnStateSnapshot | null {
    return update(agentId, turnId, current => {
      current.active = false;
      current.phase = 'idle';
      current.activity = null;
      current.lastProviderEventAt = at;
    });
  },

  get(agentId: string): LiveTurnStateSnapshot | null {
    const current = store.records.get(agentId);
    return current ? clone(current) : null;
  },

  getAll(): LiveTurnStateSnapshot[] {
    return Array.from(store.records.values(), clone);
  },

  clear(agentId: string): void {
    store.records.delete(agentId);
  },

  /** Tests only: clear HMR-safe global state without replacing the map. */
  resetForTests(): void {
    store.records.clear();
    store.nextTurnId = 1;
  },
};
