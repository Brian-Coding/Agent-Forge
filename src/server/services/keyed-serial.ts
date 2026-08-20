/**
 * Serialize mutations for one logical resource while allowing unrelated keys
 * to proceed concurrently. A rejection reaches its caller but cannot poison
 * later work, and idle keys are removed to avoid an unbounded lock registry.
 */
export async function runKeyedSerial<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const execution = previous.catch(() => {}).then(operation);
  const tail = execution.then(() => {}, () => {});
  tails.set(key, tail);
  try {
    return await execution;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}
