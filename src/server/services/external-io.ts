export class ExternalTimeoutError extends Error {
  constructor(public readonly label: string, public readonly timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'ExternalTimeoutError';
  }
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** A deadline that remains effective even if a fetch implementation ignores abort. */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 15_000,
  label = 'External request',
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<Response> {
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : 15_000;
  const controller = new AbortController();
  const upstream = init.signal;
  const onUpstreamAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) onUpstreamAbort();
  else upstream?.addEventListener('abort', onUpstreamAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new ExternalTimeoutError(label, boundedTimeout));
      reject(new ExternalTimeoutError(label, boundedTimeout));
    }, boundedTimeout);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchImpl(input, { ...init, signal: controller.signal })),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    upstream?.removeEventListener('abort', onUpstreamAbort);
  }
}

export async function readJsonResponseWithTimeout(
  response: Response,
  maxBytes = 4 * 1024 * 1024,
  timeoutMs = 15_000,
  label = 'External response',
): Promise<unknown> {
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : 4 * 1024 * 1024;
  const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : 15_000;
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) {
      throw new Error(`${label} returned an invalid Content-Length header`);
    }
    if (Number(declared) > byteLimit) throw new Error(`${label} exceeded ${byteLimit} bytes`);
  }
  if (!response.body) throw new Error(`${label} returned an empty body`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutError = new ExternalTimeoutError(label, deadlineMs);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), deadlineMs);
  });
  let completed = false;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > byteLimit) throw new Error(`${label} exceeded ${byteLimit} bytes`);
      chunks.push(value);
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (!completed) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} returned invalid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}
