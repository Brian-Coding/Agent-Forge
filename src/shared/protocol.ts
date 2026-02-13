// WebSocket message types for client-server communication

export type AgentStatus = 'idle' | 'working' | 'thinking' | 'error' | 'stopped';

export interface AgentInfo {
  id: string;
  name: string;
  cwd: string;
  referencePaths: string[];   // Additional directories for cross-repo context
  systemPrompt: string;       // Per-agent system prompt / persona
  status: AgentStatus;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ProjectNote {
  id: string;
  title: string;
  content: string;
  agentId?: string;       // Optional: tag note to a specific agent
  createdAt: number;
  updatedAt: number;
}

export interface KanbanItem {
  id: string;
  title: string;
  description: string;
  column: 'backlog' | 'in_progress' | 'done';
  order: number;
  createdAt: number;
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'create_agent'; name: string; cwd: string; referencePaths?: string[]; systemPrompt?: string }
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
  | { type: 'create_kanban_item'; title: string; description?: string; column?: KanbanItem['column'] }
  | { type: 'update_kanban_item'; id: string; title?: string; description?: string; column?: KanbanItem['column']; order?: number }
  | { type: 'delete_kanban_item'; id: string };

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
  | { type: 'kanban_item_deleted'; id: string };

// Persistence types
export interface PersistedData {
  agents: AgentInfo[];
  messages: ChatMessage[];
  sharedContext: string;
  notes: ProjectNote[];
  kanbanItems: KanbanItem[];
}
