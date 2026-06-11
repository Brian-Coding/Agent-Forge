import type { ServerWebSocket } from 'bun';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { clients, clientLastPong, broadcast, sendTo } from './broadcast';
import { agentService } from './services/agent.service';
import { noteService } from './services/note.service';
import { documentService } from './services/document.service';
import { settingsService } from './services/settings.service';
import { workspaceService } from './services/workspace.service';
import { terminalService } from './services/terminal.service';
// Side-effect imports — qa.service and atlas.service register their agent
// lifecycle listeners at module load. Importing them here guarantees the
// listeners are wired before the first WS message arrives.
import { qaService } from './services/qa.service';
import { atlasService } from './services/atlas.service';
import { chatService } from './services/chat.service';
import { usageService } from './services/usage.service';

// WebSocket heartbeat — ping every 30s, close stale clients after 40s
setInterval(() => {
  const now = Date.now();
  for (const client of clients) {
    const lastPong = clientLastPong.get(client) ?? now;
    if (now - lastPong > 40_000) {
      console.log('Closing stale WebSocket client (no pong for 40s)');
      try { client.close(); } catch {}
      clients.delete(client);
      clientLastPong.delete(client);
      continue;
    }
    try { client.ping(); } catch {}
  }
}, 30_000);

// Handle incoming WebSocket messages
async function handleMessage(ws: ServerWebSocket<unknown>, message: ClientMessage) {
  switch (message.type) {
    case 'ping': {
      sendTo(ws, { type: 'pong' });
      break;
    }

    case 'create_agent': {
      try {
        const agent = await agentService.createAgent(
          message.name,
          message.cwd,
          message.referencePaths || [],
          message.systemPrompt || '',
          message.workspaceId,
        );
        broadcast({ type: 'agent_created', agent });
        broadcast({ type: 'workspaces_list', workspaces: workspaceService.getAll() });
      } catch (e: any) {
        sendTo(ws, { type: 'error', message: e.message || 'Failed to create agent' });
      }
      break;
    }

    case 'update_agent': {
      try {
        const { id, type: _type, ...updates } = message;
        const agent = await agentService.updateAgent(id, updates);
        if (agent) {
          broadcast({ type: 'agent_updated', agent });
        } else {
          sendTo(ws, { type: 'error', message: 'Agent not found', agentId: id });
        }
      } catch (e: any) {
        sendTo(ws, { type: 'error', message: e.message || 'Failed to update agent' });
      }
      break;
    }

    case 'send_message': {
      await chatService.sendMessage(message.agentId, message.content);
      break;
    }

    case 'send_qa_message': {
      try {
        console.log(`[qa] send_qa_message ws=${message.workspaceId} src=${message.sourceAgentId} content="${message.content.slice(0, 80)}..."`);
        await qaService.sendQaMessage(message.workspaceId, message.sourceAgentId, message.content);
        console.log(`[qa] send_qa_message dispatched ok`);
      } catch (e: any) {
        console.error(`[qa] send_qa_message failed:`, e);
        sendTo(ws, { type: 'error', message: e?.message || 'QA send failed' });
      }
      break;
    }

    case 'abort_qa_test': {
      try {
        console.log(`[qa] abort_qa_test ws=${message.workspaceId}`);
        await qaService.abortQaTest(message.workspaceId);
      } catch (e: any) {
        console.error(`[qa] abort_qa_test failed:`, e);
        sendTo(ws, { type: 'error', message: e?.message || 'QA abort failed' });
      }
      break;
    }

    case 'provision_atlas_agent': {
      try {
        console.log(`[atlas] provision ws=${message.workspaceId} cwd=${message.projectCwd}`);
        const created = await atlasService.provisionAtlasAgent(message.workspaceId, message.projectCwd);
        broadcast({ type: 'agent_created', agent: created });
        broadcast({ type: 'agents_list', agents: agentService.getAgents() });
        console.log(`[atlas] agent created id=${created.id}`);
      } catch (e: any) {
        console.error(`[atlas] provision failed:`, e);
        sendTo(ws, { type: 'error', message: e?.message || 'Atlas provisioning failed' });
      }
      break;
    }

    case 'rescan_atlas': {
      try {
        console.log(`[atlas] rescan ws=${message.workspaceId}`);
        const created = await atlasService.rescanAtlas(message.workspaceId);
        broadcast({ type: 'agent_created', agent: created });
        broadcast({ type: 'agents_list', agents: agentService.getAgents() });
        console.log(`[atlas] rescan agent created id=${created.id}`);
      } catch (e: any) {
        console.error(`[atlas] rescan failed:`, e);
        sendTo(ws, { type: 'error', message: e?.message || 'Atlas rescan failed' });
      }
      break;
    }

    case 'stop_agent': {
      const success = await agentService.stopAgent(message.agentId);
      if (!success) {
        sendTo(ws, { type: 'error', message: 'Agent not found', agentId: message.agentId });
      }
      break;
    }

    case 'kill_agent': {
      const success = await agentService.killAgent(message.agentId);
      if (!success) {
        sendTo(ws, { type: 'error', message: 'Agent not found', agentId: message.agentId });
      }
      break;
    }

    case 'remove_agent': {
      const success = await agentService.removeAgent(message.agentId);
      if (success) {
        broadcast({ type: 'agent_removed', agentId: message.agentId });
        broadcast({ type: 'workspaces_list', workspaces: workspaceService.getAll() });
      } else {
        sendTo(ws, { type: 'error', message: 'Agent not found', agentId: message.agentId });
      }
      break;
    }

    case 'clear_history': {
      const success = await agentService.clearHistory(message.agentId);
      if (success) {
        broadcast({ type: 'history_cleared', agentId: message.agentId });
      }
      break;
    }

    case 'broadcast_message': {
      await Promise.all(message.agentIds.map(
        (agentId: string) => chatService.sendMessage(agentId, message.content)
      ));
      break;
    }

    case 'update_shared_context': {
      await agentService.updateSharedContext(message.content);
      broadcast({ type: 'shared_context', content: message.content });
      break;
    }

    case 'get_shared_context': {
      const content = agentService.getSharedContext();
      sendTo(ws, { type: 'shared_context', content });
      break;
    }

    case 'list_agents': {
      const agents = agentService.getAgents();
      sendTo(ws, { type: 'agents_list', agents });
      break;
    }

    case 'get_history': {
      const messages = agentService.getMessages(message.agentId);
      sendTo(ws, { type: 'history', agentId: message.agentId, messages });
      break;
    }

    // --- Notes ---
    case 'get_notes': {
      sendTo(ws, { type: 'notes_list', notes: noteService.getAll() });
      break;
    }

    case 'create_note': {
      const note = await noteService.create(message.title, message.content, message.agentId);
      broadcast({ type: 'note_created', note });
      break;
    }

    case 'update_note': {
      const { id, ...updates } = message;
      const note = await noteService.update(id, updates);
      if (note) {
        broadcast({ type: 'note_updated', note });
      } else {
        sendTo(ws, { type: 'error', message: 'Note not found' });
      }
      break;
    }

    case 'delete_note': {
      const deleted = await noteService.delete(message.id);
      if (deleted) {
        broadcast({ type: 'note_deleted', id: message.id });
      } else {
        sendTo(ws, { type: 'error', message: 'Note not found' });
      }
      break;
    }

    // --- Documents ---
    case 'get_documents': {
      sendTo(ws, { type: 'documents_list', documents: documentService.getAll() });
      break;
    }

    case 'create_document': {
      const doc = await documentService.create(message.title, message.content, message.agentId, message.workspaceId);
      broadcast({ type: 'document_created', document: doc });
      break;
    }

    case 'update_document': {
      const { id: docId, type: _docType, ...docUpdates } = message;
      const doc = await documentService.update(docId, docUpdates);
      if (doc) {
        broadcast({ type: 'document_updated', document: doc });
      } else {
        sendTo(ws, { type: 'error', message: 'Document not found' });
      }
      break;
    }

    case 'delete_document': {
      const deleted = await documentService.delete(message.id);
      if (deleted) {
        broadcast({ type: 'document_deleted', id: message.id });
      } else {
        sendTo(ws, { type: 'error', message: 'Document not found' });
      }
      break;
    }

    case 'approve_document': {
      const doc = await documentService.update(message.id, {
        status: 'approved',
        lastEditedBy: 'user',
      });
      if (doc) {
        broadcast({ type: 'document_updated', document: doc });
      } else {
        sendTo(ws, { type: 'error', message: 'Document not found' });
      }
      break;
    }

    // --- Settings ---
    case 'get_settings': {
      sendTo(ws, { type: 'settings', settings: settingsService.get() });
      break;
    }

    case 'update_settings': {
      const settings = await settingsService.update(message.settings);
      broadcast({ type: 'settings', settings });
      break;
    }

    // --- Image ---
    case 'send_image': {
      await agentService.sendImage(message.agentId, message.imageData, message.mimeType, message.prompt);
      break;
    }

    case 'send_images': {
      await agentService.sendImages(message.agentId, message.images, message.prompt);
      break;
    }

    // --- Workspaces ---
    case 'get_workspaces': {
      sendTo(ws, { type: 'workspaces_list', workspaces: workspaceService.getAll() });
      break;
    }

    case 'create_workspace': {
      const workspace = await workspaceService.create(message.name);
      broadcast({ type: 'workspace_created', workspace });
      break;
    }

    case 'update_workspace': {
      const { id: wsId, type: _wsType, ...wsUpdates } = message;
      const workspace = await workspaceService.update(wsId, wsUpdates);
      if (workspace) {
        broadcast({ type: 'workspace_updated', workspace });
      } else {
        sendTo(ws, { type: 'error', message: 'Workspace not found' });
      }
      break;
    }

    case 'delete_workspace': {
      const deleted = await workspaceService.delete(message.id, agentService.reassignAgents);
      if (deleted) {
        broadcast({ type: 'workspace_deleted', id: message.id });
        broadcast({ type: 'settings', settings: settingsService.get() });
        broadcast({ type: 'agents_list', agents: agentService.getAgents() });
      } else {
        sendTo(ws, { type: 'error', message: 'Cannot delete workspace (last one or not found)' });
      }
      break;
    }

    case 'set_active_workspace': {
      const success = await workspaceService.setActive(message.id);
      if (success) {
        broadcast({ type: 'settings', settings: settingsService.get() });
      } else {
        sendTo(ws, { type: 'error', message: 'Workspace not found' });
      }
      break;
    }

    // --- Terminals ---
    case 'create_terminal': {
      try {
        const agent = agentService.getAgent(message.agentId);
        if (!agent) throw new Error('Agent not found');
        const terminal = await terminalService.create(message.agentId, agent.cwd, message.command);
        broadcast({ type: 'terminal_created', terminal });
      } catch (e: any) {
        sendTo(ws, { type: 'error', message: e.message || 'Failed to create terminal' });
      }
      break;
    }

    case 'kill_terminal': {
      const success = await terminalService.kill(message.id);
      if (!success) {
        sendTo(ws, { type: 'error', message: 'Terminal not found' });
      }
      break;
    }

    case 'get_terminals': {
      sendTo(ws, { type: 'terminals_list', terminals: terminalService.getAll() });
      break;
    }

    case 'kill_all': {
      await agentService.killAllProcesses();
      terminalService.clearAll();
      broadcast({ type: 'agents_list', agents: agentService.getAgents() });
      broadcast({ type: 'terminals_list', terminals: terminalService.getAll() });
      break;
    }

    default:
      sendTo(ws, { type: 'error', message: 'Unknown message type' });
  }
}

/** WebSocket handlers for Bun.serve */
export const websocketHandlers = {
  open(ws: ServerWebSocket<unknown>) {
    clients.add(ws);
    clientLastPong.set(ws, Date.now());
    console.log('Client connected');

    // Send current state on connect
    sendTo(ws, { type: 'agents_list', agents: agentService.getAgents() });
    sendTo(ws, { type: 'notes_list', notes: noteService.getAll() });
    sendTo(ws, { type: 'documents_list', documents: documentService.getAll() });
    sendTo(ws, { type: 'settings', settings: settingsService.get() });
    sendTo(ws, { type: 'workspaces_list', workspaces: workspaceService.getAll() });
    sendTo(ws, { type: 'terminals_list', terminals: terminalService.getAll() });
    // Cross-provider token report — drives the Tokens sidebar tab.
    sendTo(ws, { type: 'usage_report', report: usageService.getReportForConnect() });

    // Send token usage for each agent
    for (const agent of agentService.getAgents()) {
      const usage = agentService.getTokenUsage(agent.id);
      if (usage) {
        sendTo(ws, {
          type: 'token_usage',
          agentId: agent.id,
          ...usage,
        });
      }
    }
  },

  message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
    try {
      const data = JSON.parse(message.toString()) as ClientMessage;
      handleMessage(ws, data).catch(e => {
        console.error('handleMessage error:', e);
      });
    } catch (e) {
      console.error('Failed to parse message:', e);
      sendTo(ws, { type: 'error', message: 'Invalid JSON' });
    }
  },

  pong(ws: ServerWebSocket<unknown>) {
    clientLastPong.set(ws, Date.now());
  },

  close(ws: ServerWebSocket<unknown>) {
    clients.delete(ws);
    clientLastPong.delete(ws);
    console.log('Client disconnected');
  },
};
