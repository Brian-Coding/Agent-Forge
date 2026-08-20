export class RequestBodyError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

function safeLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`Invalid request-body limit: ${maxBytes}`);
  return maxBytes;
}

/** Read a request body with both declared-length and streaming byte ceilings. */
export async function readRequestBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  const limit = safeLimit(maxBytes);
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new RequestBodyError('Invalid Content-Length header', 400);
    const length = Number(declared);
    if (!Number.isSafeInteger(length)) throw new RequestBodyError('Invalid Content-Length header', 400);
    if (length > limit) throw new RequestBodyError(`Request body exceeds ${limit} bytes`, 413);
  }
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel(new RequestBodyError(`Request body exceeds ${limit} bytes`, 413)).catch(() => {});
        throw new RequestBodyError(`Request body exceeds ${limit} bytes`, 413);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readRequestText(req: Request, maxBytes: number): Promise<string> {
  const bytes = await readRequestBytes(req, maxBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyError('Request body is not valid UTF-8', 400);
  }
}

export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const text = await readRequestText(req, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestBodyError('Request body must be valid JSON', 400);
  }
}
