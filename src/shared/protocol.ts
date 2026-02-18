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

export interface KanbanBoard {
  id: string;
  name: string;
  projectPath?: string;
  createdAt: number;
}

export interface KanbanItem {
  id: string;
  title: string;
  description: string;
  column: 'backlog' | 'in_progress' | 'done';
  order: number;
  createdAt: number;
  boardId?: string;       // Optional: assign to a specific board
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
  // Legacy fields kept for migration
  gridColumns?: number;
  gridRows?: number;
  selectedAgentIds?: string[];
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
  // Kanban
  | { type: 'get_kanban' }
  | { type: 'create_kanban_item'; title: string; description?: string; column?: KanbanItem['column']; boardId?: string }
  | { type: 'update_kanban_item'; id: string; title?: string; description?: string; column?: KanbanItem['column']; order?: number; boardId?: string }
  | { type: 'delete_kanban_item'; id: string }
  // Kanban Boards
  | { type: 'get_kanban_boards' }
  | { type: 'create_kanban_board'; name: string; projectPath?: string }
  | { type: 'delete_kanban_board'; id: string }
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
  | { type: 'set_active_workspace'; id: string };

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
  // Kanban
  | { type: 'kanban_list'; items: KanbanItem[] }
  | { type: 'kanban_item_created'; item: KanbanItem }
  | { type: 'kanban_item_updated'; item: KanbanItem }
  | { type: 'kanban_item_deleted'; id: string }
  // Kanban Boards
  | { type: 'kanban_boards_list'; boards: KanbanBoard[] }
  | { type: 'kanban_board_created'; board: KanbanBoard }
  | { type: 'kanban_board_deleted'; id: string }
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
  | { type: 'workspace_deleted'; id: string };

// Persistence types
export interface PersistedData {
  agents: AgentInfo[];
  messages: ChatMessage[];
  sharedContext: string;
  notes: ProjectNote[];
  kanbanItems: KanbanItem[];
  kanbanBoards: KanbanBoard[];
  documents: LiveDocument[];
  settings: AppSettings;
  workspaces: WorkspaceInfo[];
}
