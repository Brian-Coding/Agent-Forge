/**
 * NDJSON parsing utilities for adapters that consume line-delimited JSON
 * from a CLI's stdout (Claude `--output-format stream-json`, Codex `--json`).
 */

const MAX_STREAM_CHARS = 64_000;

/** Drain a stream to a string, capped to avoid runaway memory. */
export async function drainStreamToString(
  stream: ReadableStream<Uint8Array>,
  maxChars = MAX_STREAM_CHARS,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxChars) text = text.slice(-maxChars);
  }
  return text + decoder.decode();
}

/**
 * Parse complete NDJSON lines out of a rolling buffer; return the trailing
 * partial line as the new buffer. Lines that fail to parse are dropped
 * silently — the caller (adapter) sees only the events that JSON.parse'd.
 */
export function parseNdjsonLines(
  leftover: string,
  handler: (event: any) => void,
): string {
  const lines = leftover.split('\n');
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed) continue;
    try {
      handler(JSON.parse(trimmed));
    } catch {
      // Malformed line — ignore. Real adapters log via emitSystemMessage if needed.
    }
  }
  return remainder;
}

/** Flush a final partial line at stream end. */
export function flushNdjsonLeftover(
  leftover: string,
  handler: (event: any) => void,
): void {
  const trimmed = leftover.replace(/\r$/, '').trim();
  if (!trimmed) return;
  try {
    handler(JSON.parse(trimmed));
  } catch {
    // Drop.
  }
}
