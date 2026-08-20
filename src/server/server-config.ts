export function parseServerPort(
  raw: string | undefined,
  fallback = 3333,
  fallbackAttempts = 8,
): number {
  const candidate = raw?.trim() ? raw.trim() : String(fallback);
  if (!/^\d+$/.test(candidate)) throw new Error(`PORT must be an integer, received ${JSON.stringify(candidate)}`);
  const port = Number(candidate);
  const highestAllowed = 65_535 - Math.max(0, fallbackAttempts - 1);
  if (!Number.isSafeInteger(port) || port < 1 || port > highestAllowed) {
    throw new Error(`PORT must be between 1 and ${highestAllowed} so fallback ports remain valid`);
  }
  return port;
}
