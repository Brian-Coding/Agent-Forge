interface DurableMutationState {
  tail: Promise<void>;
}

// User-visible state is assembled from several HMR-persistent service maps.
// Serialize mutations that promise durability so a failed write can restore
// its snapshot before the next mutation observes or persists that state.
const state: DurableMutationState = (globalThis as any).__durableMutationState ??= {
  tail: Promise.resolve(),
};

export function runDurableMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = state.tail.then(operation, operation);
  state.tail = result.then(() => undefined, () => undefined);
  return result;
}
