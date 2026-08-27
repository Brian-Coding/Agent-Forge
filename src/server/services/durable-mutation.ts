import { persistenceService } from './persistence.service';

interface DurableMutationState {
  tail: Promise<void>;
}

// User-visible state is assembled from several HMR-persistent service maps.
// Serialize mutations that promise durability so a failed write can restore
// its snapshot before the next mutation observes or persists that state.
const state: DurableMutationState = (globalThis as any).__durableMutationState ??= {
  tail: Promise.resolve(),
};

async function withPersistenceGeneration<T>(operation: () => Promise<T>): Promise<T> {
  persistenceService.beginMutation('durable-mutation');
  try {
    return await operation();
  } finally {
    persistenceService.endMutation();
  }
}

export function runDurableMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = state.tail.then(
    () => withPersistenceGeneration(operation),
    () => withPersistenceGeneration(operation),
  );
  state.tail = result.then(() => undefined, () => undefined);
  return result;
}
