// WebSocket message types for client-server communication

export type AgentStatus = 'idle' | 'working' | 'thinking' | 'error' | 'stopped';

/**
 * Provider identifier. Mirrors `ChatAgentKind` in `src/server/agents/agent-kinds.ts`,
 * duplicated here so the shared wire types don't need to import server-side code.
 */
export type AgentProvider = 'claude' | 'codex';

export interface WorkspaceInfo {
  id: string;
  name: string;
  sortOrder: number;            // User-controlled order in the Workspaces sidebar
  gridColumns: number;
  gridRows: number;
  selectedAgentIds: string[];
  lockedAgentIds: string[];    // Agents locked to their current grid slot
  createdAt: number;
  testUrl?: string;            // URL the QA agent navigates to (e.g. http://localhost:5173)
  qaAgentId?: string;          // ID of the QA testing agent provisioned for this workspace (set lazily on first QA chat send)
  atlasAgentId?: string;       // ID of the UI Atlas agent provisioned for this workspace (explicit user action via the "Create UI Atlas Agent" button)
  atlasProjectCwd?: string;    // Project directory the Atlas agent reads from (and writes docs/ui-atlas/ into). Persisted so re-scans don't re-prompt.
  atlasLastScanAt?: number;    // Timestamp of last completed atlas scan (when atlas agent transitioned working → idle).
  qaSurfaceVerifications?: Record<string, number>; // surface slug -> last QA-verification timestamp. Stamped when a QA report references surface.<slug>.
}

export interface AgentInfo {
  id: string;
  name: string;
  cwd: string;
  referencePaths: string[];   // Additional directories for cross-repo context
  systemPrompt: string;       // Per-agent system prompt / persona
  status: AgentStatus;
  createdAt: number;
  workspaceId: string;        // Workspace this agent belongs to
  hideFromGrid?: boolean;     // True for special-purpose agents (UI Atlas, QA Tester) that shouldn't take grid slots or appear in chip lists
  // Provider / model selection (hot-swappable per agent, per the inline dropdowns under each chat input)
  provider?: AgentProvider;   // Defaults to 'claude' when absent (backward compat with pre-rebuild data.json)
  model?: string;             // Provider-scoped model id; null → adapter default
  reasoningLevel?: string;    // Codex-only; validated against the selected model's live capabilities
  /**
   * Set when a turn's ground-truth model (reported by the CLI) differed from
   * the model the user selected — e.g. the service silently served Opus for a
   * large-context Fable request. While set, chat.service REFUSES new sends for
   * this agent; the UI renders a blocking banner whose two actions resolve it
   * (continue on `ran`, or start a fresh session on `requested`).
   */
  modelMismatch?: { requested: string; ran: string; at: number } | null;
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  supportedReasoningLevels?: string[];
  defaultReasoningLevel?: string;
}

export interface AgentProviderDefinition {
  kind: AgentProvider;
  label: string;
  supportsResume: boolean;
  supportsReasoningLevel: boolean;
  models: ModelOption[];
  defaultModel: string;
  reasoningLevels?: string[];
  defaultReasoningLevel?: string;
}

export interface ModelCatalogResponse {
  providers: Record<AgentProvider, AgentProviderDefinition>;
}

/**
 * Server-side persistence shape for an agent: the wire AgentInfo plus the
 * fields that aren't surfaced to the UI (current session, token accounting,
 * etc.). Stored in data.json.
 *
 * Session model: one current session per agent, owned by exactly one
 * provider/model pair. When the user swaps provider or model, the next turn starts fresh
 * (with prior UI chat history prepended into the prompt) and the new
 * provider/model claims currentSessionId/currentSessionProvider/currentSessionModel as its own.
 */
export interface PersistedAgentRecord extends AgentInfo {
  currentSessionId?: string | null;
  currentSessionProvider?: AgentProvider | null;
  currentSessionModel?: string | null;
  contextTokens?: number;
  contextLimit?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  numTurns?: number;
}

/**
 * One-time, idempotent normalization of a persisted agent record on load.
 * Two historical layouts get migrated forward to the unified-session shape:
 *
 *   v1 (pre-rebuild):   { sessionId: 'abc' }
 *     → { currentSessionId: 'abc', currentSessionProvider: 'claude' }
 *
 *   v2 (Phase 1 rebuild): { sessionIds: { claude: 'a', codex: 'b' } }
 *     → { currentSessionId: 'a', currentSessionProvider: 'claude' }
 *       (Codex session is dropped — we can't carry both forward; the lost
 *        side starts fresh on next turn with full UI history prepended.)
 *
 *   v3 (current):       { currentSessionId, currentSessionProvider, currentSessionModel }
 *     → unchanged
 *
 * Also defaults `provider` to 'claude' so the inline dropdown always has
 * a valid value, and clears the agent of any unknown shapes.
 */
export function migrateAgentRecord(raw: any): PersistedAgentRecord {
  if (!raw || typeof raw !== 'object') return raw;
  const record: any = { ...raw };

  // v1 → v3: legacy top-level `sessionId` string
  if (typeof record.sessionId === 'string' && record.sessionId && !record.currentSessionId) {
    record.currentSessionId = record.sessionId;
    record.currentSessionProvider = 'claude';
  }
  delete record.sessionId;

  // v2 → v3: per-provider sessionIds map (preserve claude side if present)
  if (record.sessionIds && typeof record.sessionIds === 'object' && !record.currentSessionId) {
    if (typeof record.sessionIds.claude === 'string' && record.sessionIds.claude) {
      record.currentSessionId = record.sessionIds.claude;
      record.currentSessionProvider = 'claude';
    } else if (typeof record.sessionIds.codex === 'string' && record.sessionIds.codex) {
      record.currentSessionId = record.sessionIds.codex;
      record.currentSessionProvider = 'codex';
    }
  }
  delete record.sessionIds;

  // Default provider for the inline dropdown.
  if (record.provider !== 'claude' && record.provider !== 'codex') {
    record.provider = 'claude';
  }

  // Normalize modelMismatch: anything other than the full well-formed shape
  // collapses to null so a corrupt record can't permanently wedge sends.
  const mm = record.modelMismatch;
  if (!mm || typeof mm !== 'object'
      || typeof mm.requested !== 'string' || !mm.requested
      || typeof mm.ran !== 'string' || !mm.ran) {
    record.modelMismatch = null;
  } else {
    record.modelMismatch = { requested: mm.requested, ran: mm.ran, at: typeof mm.at === 'number' ? mm.at : Date.now() };
  }

  // Normalize empty session marker to null instead of undefined.
  if (!record.currentSessionId) {
    record.currentSessionId = null;
    record.currentSessionProvider = null;
    record.currentSessionModel = null;
  } else if (typeof record.currentSessionModel !== 'string' || !record.currentSessionModel) {
    // Existing sessions pre-date model binding, so they are unsafe to resume:
    // the CLI may keep the old session's model even when a new --model is passed.
    record.currentSessionModel = null;
  }

  return record as PersistedAgentRecord;
}

export interface ChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  imageData?: string;         // Base64 encoded image data
  imageMimeType?: string;     // e.g. 'image/png', 'image/jpeg'
  source?: 'qa';              // QA-originated message (for visual styling)
  provider?: AgentProvider;   // Which provider produced this turn (assistant messages only). Stamped at turn-finalize. Legacy messages without this field display as 'Claude' for backward compat.
  model?: string;             // Which model actually produced this turn when the provider reports it.
}

/**
 * Backend representation of a plan document. The Plans sidebar UI was removed
 * (2026-07-09); these records now exist purely as the agent-facing `.plans/`
 * plumbing — file sync, prompt context, and write-lock tracking.
 */
export interface LiveDocument {
  id: string;
  title: string;
  content: string;
  lastEditedBy: string;   // 'user' or agent name
  agentId?: string;       // Optional: assign to a specific agent
  workspaceId?: string;   // Workspace this plan belongs to
  status: 'draft' | 'approved' | 'in_progress';  // plan approval status
  lockedBy?: string;      // agent ID currently writing
  filePath?: string;      // .plans/ file path for sync
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  defaultSimulatorUdid?: string;
  defaultSimulatorName?: string;
  activeWorkspaceId?: string;
  sidebarWidth?: number;
  // Legacy fields kept for migration
  gridColumns?: number;
  gridRows?: number;
  selectedAgentIds?: string[];
}

export interface TerminalSession {
  id: string;
  agentId: string;
  command: string;
  cwd: string;
  status: 'running' | 'stopped';
  createdAt: number;
}

/**
 * One usage entry per agent turn. Coalesces all `usage` events emitted by
 * the adapter within a single turn into a single record so the log grows
 * at most one row per turn (~150 bytes). Provider stamped so the cost
 * tracker can break down Claude vs Codex spend.
 */
export interface UsageEvent {
  id?: string;            // Stable event id used to de-duplicate cross-machine shards
  machineId?: string;     // Machine that recorded the event
  timestamp: number;
  agentId: string;
  provider: AgentProvider;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  /**
   * Enrichment fields (2026-07-09, Token Usage redesign). Stamped at record
   * time when known; absent on historical events, which the report renders
   * as "(unrecorded)".
   */
  model?: string;        // ground-truth model that served the turn (modelRan, else resolved)
  agentName?: string;    // agent display name at event time (survives agent deletion)
  workspaceId?: string;  // workspace the agent belonged to at event time
  workspaceName?: string; // workspace display name at event time (survives rename/deletion)
}

/**
 * Tokens-only rollup for one provider (or the combined total). Cost values
 * are still captured in `UsageEvent.costUsd` for posterity but are not
 * surfaced in the UI: the only provider that emits authoritative cost
 * (Claude's `total_cost_usd` in its result event) makes side-by-side
 * comparison misleading once Codex's $0 lands next to it.
 */
export interface ProviderTokenBucket {
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface WindowTokenSummary {
  claude: ProviderTokenBucket;
  codex: ProviderTokenBucket;
  total: ProviderTokenBucket;
}

/** One breakdown row (per agent or per model) inside a usage window. */
export interface UsageBreakdownRow {
  key: string;                   // agentId or model id
  label: string;                 // display label (agent name / model id)
  claude: ProviderTokenBucket;
  codex: ProviderTokenBucket;
  total: ProviderTokenBucket;
  lastTimestamp: number;
}

/** Derived headline stats for one usage window. */
export interface UsageWindowStats {
  totalTokens: number;
  turns: number;
  avgInputPerTurn: number;       // rounded
  avgOutputPerTurn: number;      // rounded
  outputInputRatio: number | null;  // null when no input tokens in window
  biggestTurn: {
    tokens: number;
    agentName: string;
    provider: AgentProvider;
    model?: string;
    timestamp: number;
  } | null;
}

/** Everything the Tokens tab needs for one time window. */
export interface UsageWindowReport {
  summary: WindowTokenSummary;
  byAgent: UsageBreakdownRow[];  // sorted by total tokens desc
  byModel: UsageBreakdownRow[];  // sorted by total tokens desc
  projects: UsageProjectGroup[]; // projects with their most recent turns nested beneath them
  stats: UsageWindowStats;
}

export interface UsageTurnRow {
  id: string;
  timestamp: number;
  agentId: string;
  agentName: string;
  provider: AgentProvider;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageProjectGroup {
  workspaceId: string;
  workspaceName: string;
  total: ProviderTokenBucket;
  lastTimestamp: number;
  eventCount: number;
  /** Newest first and capped by the server to keep long-lived logs responsive. */
  turns: UsageTurnRow[];
}

/** One calendar day's provider-split totals (local time). */
export interface UsageDailyRow {
  date: string;                  // YYYY-MM-DD local
  claude: ProviderTokenBucket;
  codex: ProviderTokenBucket;
  total: ProviderTokenBucket;
}

/**
 * Full usage report rendered by the Tokens sidebar tab. Windows are
 * calendar-aligned to the server's local time (which is the user's local
 * time, since the server runs on the user's machine). `days7`/`days30`
 * are rolling windows (now minus N days); `today`/`month` are calendar
 * windows; `allTime` covers the whole log.
 */
export interface UsageReport {
  windows: {
    today: UsageWindowReport;
    days7: UsageWindowReport;
    days30: UsageWindowReport;
    month: UsageWindowReport;
    allTime: UsageWindowReport;
  };
  /** Last 30 calendar days, oldest first, zero-filled so charts have no gaps. */
  daily: UsageDailyRow[];
  /** Earliest tracked event and cross-machine shard status. */
  trackingStartedAt: number | null;
  sync: {
    enabled: boolean;
    machineId: string;
    machineCount: number;
    directory: string | null;
  };
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Provider limits (Limits sidebar tab)
// ---------------------------------------------------------------------------

export type LimitsProviderStatus = 'available' | 'stale' | 'unavailable' | 'error';

/** One rate-limit window (5-hour or weekly). */
export interface LimitsWindow {
  usedPercent: number | null;
  resetsAt: number | null;       // epoch ms
  windowMinutes: number | null;  // 300 for 5h, 10080 for weekly (when the source reports it)
}

export interface ProviderLimitsSnapshot {
  provider: AgentProvider;
  status: LimitsProviderStatus;
  /** When the underlying data was produced (statusline write / rollout event). */
  updatedAt: number | null;
  /** When the limits service last read the source. */
  checkedAt: number;
  model: string | null;
  planType: string | null;
  contextUsedPercent: number | null;
  fiveHour: LimitsWindow;
  weekly: LimitsWindow;
  /** Human-readable description of where the data came from. */
  source: string;
  /** Error text or setup hint when status is unavailable/error. */
  detail: string | null;
}

export interface LimitsSnapshot {
  providers: { claude: ProviderLimitsSnapshot; codex: ProviderLimitsSnapshot };
  refreshIntervalMs: number;
  nextRefreshAt: number;
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'create_agent'; name: string; cwd: string; referencePaths?: string[]; systemPrompt?: string; workspaceId?: string }
  | { type: 'update_agent'; id: string; name?: string; cwd?: string; referencePaths?: string[]; systemPrompt?: string; provider?: AgentProvider; model?: string; reasoningLevel?: string }
  | { type: 'resolve_model_mismatch'; id: string; action: 'continue-actual' | 'fresh-requested' }
  | { type: 'send_message'; agentId: string; content: string }
  | { type: 'kill_agent'; agentId: string }
  | { type: 'stop_agent'; agentId: string }
  | { type: 'remove_agent'; agentId: string }
  | { type: 'clear_history'; agentId: string }
  | { type: 'update_shared_context'; content: string }
  | { type: 'get_shared_context' }
  | { type: 'list_agents' }
  | { type: 'get_history'; agentId: string }
  // Settings
  | { type: 'get_settings' }
  | { type: 'update_settings'; settings: Partial<AppSettings> }
  // Image
  | { type: 'send_image'; agentId: string; imageData: string; mimeType: string; prompt?: string }
  | { type: 'send_images'; agentId: string; images: { imageData: string; mimeType: string }[]; prompt?: string }
  // Workspaces
  | { type: 'get_workspaces' }
  | { type: 'create_workspace'; name: string }
  | { type: 'update_workspace'; id: string; name?: string; gridColumns?: number; gridRows?: number; selectedAgentIds?: string[]; lockedAgentIds?: string[]; testUrl?: string }
  | { type: 'reorder_workspaces'; orderedIds: string[] }
  | { type: 'delete_workspace'; id: string }
  | { type: 'set_active_workspace'; id: string }
  // QA testing
  | { type: 'send_qa_message'; workspaceId: string; sourceAgentId: string; content: string }
  | { type: 'abort_qa_test'; workspaceId: string }
  // UI Atlas
  | { type: 'provision_atlas_agent'; workspaceId: string; projectCwd: string }
  | { type: 'rescan_atlas'; workspaceId: string }
  // Terminals
  | { type: 'create_terminal'; agentId: string; command: string }
  | { type: 'kill_terminal'; id: string }
  | { type: 'get_terminals' }
  // Limits
  | { type: 'refresh_limits' }
  // Kill all
  | { type: 'kill_all' }
  // App-level heartbeat — browsers can't send protocol-level pings, so the
  // client uses this to detect half-open sockets (e.g. after sleep/resume).
  | { type: 'ping' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'agent_created'; agent: AgentInfo }
  | { type: 'agent_updated'; agent: AgentInfo }
  | { type: 'agent_removed'; agentId: string }
  | { type: 'agents_list'; agents: AgentInfo[] }
  | { type: 'output'; agentId: string; content: string; stream: 'stdout' | 'stderr' }
  | { type: 'agent_activity'; agentId: string; label: string; timestamp: number }
  | { type: 'thinking_output'; agentId: string; content: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'history'; agentId: string; messages: ChatMessage[] }
  | { type: 'history_cleared'; agentId: string }
  | { type: 'shared_context'; content: string }
  | { type: 'file_changed'; agentId: string; files: string[] }
  | { type: 'error'; message: string; agentId?: string }
  // Settings
  | { type: 'settings'; settings: AppSettings }
  // Token usage (per-agent live state — drives the per-chat context bar)
  | { type: 'token_usage'; agentId: string; contextTokens: number; contextLimit: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number; numTurns: number; modelRan?: string }
  // Full token report (windows + per-agent) — drives the Tokens sidebar tab.
  | { type: 'usage_report'; report: UsageReport }
  // Provider rate-limit snapshot — drives the Limits sidebar tab.
  | { type: 'limits_snapshot'; snapshot: LimitsSnapshot }
  // Workspaces
  | { type: 'workspaces_list'; workspaces: WorkspaceInfo[] }
  | { type: 'workspace_created'; workspace: WorkspaceInfo }
  | { type: 'workspace_updated'; workspace: WorkspaceInfo }
  | { type: 'workspace_deleted'; id: string }
  // QA testing
  | { type: 'qa_results_ready'; workspaceId: string; sourceAgentId: string }
  | { type: 'qa_screenshot_taken'; workspaceId: string; path: string; timestamp: number }
  | { type: 'qa_stuck_warning'; workspaceId: string; endpoint: string; repeatCount: number; argsPreview: string }
  // Terminals
  | { type: 'terminals_list'; terminals: TerminalSession[] }
  | { type: 'terminal_created'; terminal: TerminalSession }
  | { type: 'terminal_output'; terminalId: string; content: string }
  | { type: 'terminal_exited'; terminalId: string; exitCode: number | null }
  // Heartbeat reply
  | { type: 'pong' };

// Persistence types
export interface PersistedData {
  agents: AgentInfo[];
  messages: ChatMessage[];
  sharedContext: string;
  /**
   * Legacy field — the Notes feature was removed (2026-07-09). Old data.json
   * files may still carry it; it's ignored on load and no longer written.
   */
  notes?: unknown[];
  documents: LiveDocument[];
  settings: AppSettings;
  workspaces: WorkspaceInfo[];
  /**
   * Append-only usage log: one entry per finalized agent turn, with the
   * provider stamped so the bottom-bar cost tracker can break down spend
   * by Claude vs Codex over rolling time windows. Optional/undefined for
   * pre-rebuild data.json files; loaded as [] in that case.
   */
  usageEvents?: UsageEvent[];
}
