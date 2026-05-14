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
  reasoningLevel?: string;    // Codex-only (low / medium / high / xhigh)
}

/**
 * Server-side persistence shape for an agent: the wire AgentInfo plus the
 * fields that aren't surfaced to the UI (current session, token accounting,
 * etc.). Stored in data.json.
 *
 * Session model: one current session per agent, owned by exactly one
 * provider. When the user swaps provider, the next turn starts fresh
 * (with prior UI chat history prepended into the prompt) and the new
 * provider claims currentSessionId/currentSessionProvider as its own.
 */
export interface PersistedAgentRecord extends AgentInfo {
  currentSessionId?: string | null;
  currentSessionProvider?: AgentProvider | null;
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
 *   v3 (current):       { currentSessionId, currentSessionProvider }
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

  // Normalize empty session marker to null instead of undefined.
  if (!record.currentSessionId) {
    record.currentSessionId = null;
    record.currentSessionProvider = null;
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
}

export interface ProjectNote {
  id: string;
  title: string;
  content: string;
  agentId?: string;       // Optional: tag note to a specific agent
  createdAt: number;
  updatedAt: number;
}


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

// Client -> Server messages
export type ClientMessage =
  | { type: 'create_agent'; name: string; cwd: string; referencePaths?: string[]; systemPrompt?: string; workspaceId?: string }
  | { type: 'update_agent'; id: string; name?: string; cwd?: string; referencePaths?: string[]; systemPrompt?: string; provider?: AgentProvider; model?: string; reasoningLevel?: string }
  | { type: 'send_message'; agentId: string; content: string }
  | { type: 'kill_agent'; agentId: string }
  | { type: 'stop_agent'; agentId: string }
  | { type: 'remove_agent'; agentId: string }
  | { type: 'clear_history'; agentId: string }
  | { type: 'broadcast_message'; agentIds: string[]; content: string }
  | { type: 'update_shared_context'; content: string }
  | { type: 'get_shared_context' }
  | { type: 'list_agents' }
  | { type: 'get_history'; agentId: string }
  // Notes
  | { type: 'get_notes' }
  | { type: 'create_note'; title: string; content: string; agentId?: string }
  | { type: 'update_note'; id: string; title?: string; content?: string; agentId?: string | null }
  | { type: 'delete_note'; id: string }
  // Documents
  | { type: 'get_documents' }
  | { type: 'create_document'; title: string; content: string; agentId?: string; workspaceId?: string }
  | { type: 'update_document'; id: string; title?: string; content?: string; agentId?: string | null; lastEditedBy?: string; status?: 'draft' | 'approved' | 'in_progress' }
  | { type: 'delete_document'; id: string }
  | { type: 'approve_document'; id: string }
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
  // Kill all
  | { type: 'kill_all' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'agent_created'; agent: AgentInfo }
  | { type: 'agent_updated'; agent: AgentInfo }
  | { type: 'agent_removed'; agentId: string }
  | { type: 'agents_list'; agents: AgentInfo[] }
  | { type: 'output'; agentId: string; content: string; stream: 'stdout' | 'stderr' }
  | { type: 'thinking_output'; agentId: string; content: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'history'; agentId: string; messages: ChatMessage[] }
  | { type: 'history_cleared'; agentId: string }
  | { type: 'shared_context'; content: string }
  | { type: 'file_changed'; agentId: string; files: string[] }
  | { type: 'error'; message: string; agentId?: string }
  // Notes
  | { type: 'notes_list'; notes: ProjectNote[] }
  | { type: 'note_created'; note: ProjectNote }
  | { type: 'note_updated'; note: ProjectNote }
  | { type: 'note_deleted'; id: string }
  // Documents
  | { type: 'documents_list'; documents: LiveDocument[] }
  | { type: 'document_created'; document: LiveDocument }
  | { type: 'document_updated'; document: LiveDocument }
  | { type: 'document_deleted'; id: string }
  | { type: 'document_content_stream'; documentId: string; content: string }
  // Settings
  | { type: 'settings'; settings: AppSettings }
  // Token usage
  | { type: 'token_usage'; agentId: string; contextTokens: number; contextLimit: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number; numTurns: number }
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
  | { type: 'terminal_exited'; terminalId: string; exitCode: number | null };

// Persistence types
export interface PersistedData {
  agents: AgentInfo[];
  messages: ChatMessage[];
  sharedContext: string;
  notes: ProjectNote[];
  documents: LiveDocument[];
  settings: AppSettings;
  workspaces: WorkspaceInfo[];
}
