/**
 * NDJSON parsing utilities for adapters that consume line-delimited JSON
 * from a CLI's stdout (Claude `--output-format stream-json`, Codex `--json`).
 */

const MAX_STREAM_CHARS = 64_000;

// CLI output can contain terminal control sequences even in JSON mode when a
// nested command or native dependency writes diagnostics. Keep those bytes out
// of browser text nodes; broken UTF-8 ANSI prefixes are handled as well.
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /(?:\x1b\[|\uFFFD\[)[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\uFFFD]/g;

export function sanitizeCliText(text: string): string {
  if (!text) return '';
  const stripped = text.replace(ANSI_OSC, '').replace(ANSI_CSI, '');
  let unsafe = 0;
  for (const char of stripped) {
    const code = char.charCodeAt(0);
    if (code === 0xfffd || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      || (code >= 0x7f && code <= 0x9f)) unsafe++;
  }
  if (unsafe > Math.max(4, stripped.length * 0.12)) return '';
  const cleaned = stripped.replace(UNSAFE_CONTROL, '');
  if (/AWAVAUATVWUSH/.test(cleaned) && /[^\x20-\x7e\r\n\t]/.test(cleaned)) return '';
  return cleaned;
}

/** Keep visible reasoning useful without turning command/code dumps into a wall. */
export function compactThinkingText(text: string, maxChars = 700): string {
  const clean = sanitizeCliText(text).trim();
  if (!clean) return '';
  const lines = clean.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  const codeLikeLines = lines.filter(line =>
    /^\s*\d+:\s/.test(line)
    || /^\s*(?:at |FAIL\b|PASS\b|Expected\b|Received\b|[+\-] )/i.test(line)
    || /[{}();]{3,}/.test(line),
  ).length;
  if (lines.length >= 6 && codeLikeLines >= Math.ceil(lines.length * 0.45)) {
    const narrative = lines.find(line =>
      !/^\s*\d+:\s/.test(line)
      && !/^\s*(?:at |FAIL\b|PASS\b|Expected\b|Received\b|[+\-] )/i.test(line)
      && !/[{}();]{3,}/.test(line),
    );
    return narrative && narrative.length <= 180
      ? narrative
      : 'Reviewing code and command results…';
  }
  const normalized = lines.join('\n');
  if (normalized.length <= maxChars) return normalized;
  const sentenceEnd = normalized.lastIndexOf('. ', maxChars);
  const cut = sentenceEnd >= Math.floor(maxChars * 0.45) ? sentenceEnd + 1 : maxChars;
  return normalized.slice(0, cut).trimEnd() + '…';
}

/** Drain a stream to a string, capped to avoid runaway memory. */
export async function drainStreamToString(
  stream: ReadableStream<Uint8Array>,
  maxChars = MAX_STREAM_CHARS,
  signal?: AbortSignal,
  retain: 'head' | 'tail' = 'tail',
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      if (retain === 'head') {
        if (text.length < maxChars) text += decoded.slice(0, maxChars - text.length);
      } else {
        text += decoded;
        if (text.length > maxChars) text = text.slice(-maxChars);
      }
    }
    const final = decoder.decode();
    if (retain === 'head') {
      if (text.length < maxChars) text += final.slice(0, maxChars - text.length);
      return text;
    }
    text += final;
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } finally {
    signal?.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch {}
  }
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
