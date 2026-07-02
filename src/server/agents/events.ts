/**
 * Normalized event taxonomy. Every adapter emits these; the ChatService bridge
 * is the only consumer. Provider-specific shapes never escape the adapter.
 *
 * Extended beyond the reference design with:
 *   - `usage`  — token + cost accounting (Claude reports natively; Codex skipped in Phase 3)
 *   - `stderr` — surfaced as `output` with stream='stderr' on the wire
 */
export type AgentEvent =
  | { type: 'session'; providerSessionId: string }
  | {
      type: 'status';
      status: 'thinking' | 'responding' | 'tool' | 'idle' | 'error';
      label?: string;
    }
  | { type: 'text-delta'; text: string; messageId?: string }
  | { type: 'thinking-delta'; text: string; messageId?: string }
  | {
      type: 'tool-call-start';
      toolCallId: string;
      toolName: string;
      input?: unknown;
      summary?: string;
    }
  | { type: 'tool-call-delta'; toolCallId: string; delta: string }
  | {
      type: 'tool-call-end';
      toolCallId: string;
      output?: unknown;
      error?: string;
    }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string }
  | { type: 'finish'; reason?: string }
  | { type: 'stderr'; text: string }
  | {
      /**
       * Adapter reports a usage data point. The bridge (chat.service) applies
       * snapshot fields by assignment and delta fields by addition onto the
       * agent's running totals, then broadcasts `token_usage` with the new
       * totals. Adapters set only the fields they have data for; any absent
       * field is left untouched on the agent state.
       */
      type: 'usage';
      contextTokens?: number;        // snapshot: current context window usage
      contextLimit?: number;         // snapshot: provider's max context window
      inputTokensDelta?: number;     // accumulate
      outputTokensDelta?: number;    // accumulate
      costUsdDelta?: number;         // accumulate
      turnsDelta?: number;           // accumulate
      modelRan?: string;             // snapshot: the model the CLI actually ran (from result.modelUsage)
    }
  | {
      type: 'raw';
      provider: 'claude' | 'codex';
      eventType?: string;
      event: unknown;
    };

// --- helpers ----------------------------------------------------------------

function trimText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function basename(p: string): string {
  if (!p) return p;
  const normalized = p.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? normalized : normalized.slice(idx + 1);
}

/**
 * Best-effort one-line summary of a tool input. Returns an empty string when
 * no useful field is present — the caller decides how to render that case
 * (typically as just `[ToolName]` with no colon-suffix).
 *
 * Covers the common Claude / Codex tool input shapes:
 *   - Bash / shell:                 { command }       → the command string
 *   - WebSearch / search:           { query }         → the query string
 *   - Read / Edit / NotebookEdit:   { file_path }     → basename of the path
 *   - Glob / Grep:                  { pattern }       → the pattern string
 *   - WebFetch:                     { url }           → the URL
 *   - LS:                           { path }          → basename of the path
 *   - MultiEdit / batch operations: { files | changes } → first basename + count
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const payload = input as Record<string, unknown>;

  const command = payload.command ?? payload.cmd;
  if (typeof command === 'string' && command) return trimText(command, 64);

  const query = payload.query;
  if (typeof query === 'string' && query) return trimText(query, 64);

  // Glob / Grep — pattern is the load-bearing field
  const pattern = payload.pattern;
  if (typeof pattern === 'string' && pattern) return trimText(pattern, 64);

  // WebFetch — URL identifies the call
  const url = payload.url;
  if (typeof url === 'string' && url) return trimText(url, 64);

  const path = payload.path ?? payload.file ?? payload.file_path;
  if (typeof path === 'string' && path) return basename(path);

  const files = payload.files ?? payload.changes;
  if (Array.isArray(files) && files.length > 0) {
    const first = files[0];
    const firstPath =
      typeof first === 'string'
        ? first
        : typeof first === 'object' && first
          ? ((first as Record<string, unknown>).path ??
              (first as Record<string, unknown>).file ??
              (first as Record<string, unknown>).file_path)
          : null;
    if (typeof firstPath === 'string' && firstPath) {
      return files.length === 1
        ? basename(firstPath)
        : `${basename(firstPath)} +${files.length - 1}`;
    }
    return `${files.length} changes`;
  }

  // Todo / planning tools — describe by count
  const todos = payload.todos;
  if (Array.isArray(todos)) return `${todos.length} todos`;

  return '';
}
