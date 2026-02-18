// WebSocket message types for client-server communication

export type AgentStatus = 'idle' | 'working' | 'thinking' | 'error' | 'stopped';

export interface WorkspaceInfo {
  id: string;
  name: string;
  gridColumns: number;
  gridRows: number;
  selectedAgentIds: string[];
  createdAt: number;
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
}

export interface ChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  imageData?: string;         // Base64 encoded image data
  imageMimeType?: string;     // e.g. 'image/png', 'image/jpeg'
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
  | { type: 'update_agent'; id: string; name?: string; cwd?: string; referencePaths?: string[]; systemPrompt?: string }
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
  | { type: 'create_document'; title: string; content: string; agentId?: string }
  | { type: 'update_document'; id: string; title?: string; content?: string; agentId?: string | null; lastEditedBy?: string }
  | { type: 'delete_document'; id: string }
  // Settings
  | { type: 'get_settings' }
  | { type: 'update_settings'; settings: Partial<AppSettings> }
  // Image
  | { type: 'send_image'; agentId: string; imageData: string; mimeType: string; prompt?: string }
  // Workspaces
  | { type: 'get_workspaces' }
  | { type: 'create_workspace'; name: string }
  | { type: 'update_workspace'; id: string; name?: string; gridColumns?: number; gridRows?: number; selectedAgentIds?: string[] }
  | { type: 'delete_workspace'; id: string }
  | { type: 'set_active_workspace'; id: string }
  // Terminals
  | { type: 'create_terminal'; agentId: string; command: string }
  | { type: 'kill_terminal'; id: string }
  | { type: 'get_terminals' };

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
  // Settings
  | { type: 'settings'; settings: AppSettings }
  // Token usage
  | { type: 'token_usage'; agentId: string; contextTokens: number; contextLimit: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number; numTurns: number }
  // Workspaces
  | { type: 'workspaces_list'; workspaces: WorkspaceInfo[] }
  | { type: 'workspace_created'; workspace: WorkspaceInfo }
  | { type: 'workspace_updated'; workspace: WorkspaceInfo }
  | { type: 'workspace_deleted'; id: string }
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
