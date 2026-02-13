import type { ServerWebSocket } from 'bun';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { agentManager } from './agent-manager';
import type { ClientMessage, ServerMessage, AgentInfo } from '../shared/protocol';
import index from '../client/index.html';

// API to list directories
async function listDirectories(path: string): Promise<{ name: string; path: string; isDirectory: boolean }[]> {
  try {
    const entries = readdirSync(path);
    const results = [];
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      try {
        const fullPath = join(path, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push({ name: entry, path: fullPath, isDirectory: true });
        }
      } catch {
        // Skip entries we can't access
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    return [];
  }
}

// Track all connected WebSocket clients
const clients = new Set<ServerWebSocket<unknown>>();

// Safe broadcast — try/catch per client to prevent one dead client from breaking others
function broadcast(message: ServerMessage) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    try {
      client.send(data);
    } catch (e) {
      // Client is dead, remove it
      clients.delete(client);
    }
  }
}

// Set up agent manager callbacks
agentManager.setOutputCallback((agentId, content, stream) => {
  broadcast({ type: 'output', agentId, content, stream });
});

agentManager.setStatusCallback((agent: AgentInfo) => {
  broadcast({ type: 'agent_updated', agent });
});

agentManager.setMessageCallback((message) => {
  broadcast({ type: 'message', message });
});

agentManager.setFileChangeCallback((agentId, files) => {
  broadcast({ type: 'file_changed', agentId, files });
});

agentManager.setThinkingCallback((agentId, content) => {
  broadcast({ type: 'thinking_output', agentId, content });
});

// Handle incoming WebSocket messages
async function handleMessage(ws: ServerWebSocket<unknown>, message: ClientMessage) {
  switch (message.type) {
    case 'create_agent': {
      try {
        const agent = await agentManager.createAgent(
          message.name,
          message.cwd,
          message.referencePaths || [],
          message.systemPrompt || ''
        );
        broadcast({ type: 'agent_created', agent });
      } catch (e: any) {
        ws.send(JSON.stringify({ type: 'error', message: e.message || `Failed to create agent` }));
      }
      break;
    }

    case 'send_message': {
      agentManager.sendMessage(message.agentId, message.content);
      break;
    }

    case 'stop_agent': {
      const success = await agentManager.stopAgent(message.agentId);
      if (!success) {
        ws.send(JSON.stringify({ type: 'error', message: 'Agent not found', agentId: message.agentId }));
      }
      break;
    }

    case 'kill_agent': {
      const success = await agentManager.killAgent(message.agentId);
      if (!success) {
        ws.send(JSON.stringify({ type: 'error', message: 'Agent not found', agentId: message.agentId }));
      }
      break;
    }

    case 'remove_agent': {
      const success = await agentManager.removeAgent(message.agentId);
      if (success) {
        broadcast({ type: 'agent_removed', agentId: message.agentId });
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Agent not found', agentId: message.agentId }));
      }
      break;
    }

    case 'clear_history': {
      const success = await agentManager.clearHistory(message.agentId);
      if (success) {
        broadcast({ type: 'history_cleared', agentId: message.agentId });
      }
      break;
    }

    case 'broadcast_message': {
      for (const agentId of message.agentIds) {
        agentManager.sendMessage(agentId, message.content);
      }
      break;
    }

    case 'update_shared_context': {
      await agentManager.updateSharedContext(message.content);
      broadcast({ type: 'shared_context', content: message.content });
      break;
    }

    case 'get_shared_context': {
      const content = agentManager.getSharedContext();
      ws.send(JSON.stringify({ type: 'shared_context', content }));
      break;
    }

    case 'list_agents': {
      const agents = agentManager.getAgents();
      ws.send(JSON.stringify({ type: 'agents_list', agents }));
      break;
    }

    case 'get_history': {
      const messages = agentManager.getMessages(message.agentId);
      ws.send(JSON.stringify({ type: 'history', agentId: message.agentId, messages }));
      break;
    }

    // --- Notes ---
    case 'get_notes': {
      const notes = agentManager.getNotes();
      ws.send(JSON.stringify({ type: 'notes_list', notes }));
      break;
    }

    case 'create_note': {
      const note = await agentManager.createNote(message.title, message.content, message.agentId);
      broadcast({ type: 'note_created', note });
      break;
    }

    case 'update_note': {
      const { id, ...updates } = message;
      const note = await agentManager.updateNote(id, updates);
      if (note) {
        broadcast({ type: 'note_updated', note });
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Note not found' }));
      }
      break;
    }

    case 'delete_note': {
      const deleted = await agentManager.deleteNote(message.id);
      if (deleted) {
        broadcast({ type: 'note_deleted', id: message.id });
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Note not found' }));
      }
      break;
    }

    // --- Kanban ---
    case 'get_kanban': {
      const items = agentManager.getKanbanItems();
      ws.send(JSON.stringify({ type: 'kanban_list', items }));
      break;
    }

    case 'create_kanban_item': {
      const item = await agentManager.createKanbanItem(message.title, message.description, message.column);
      broadcast({ type: 'kanban_item_created', item });
      break;
    }

    case 'update_kanban_item': {
      const { id: itemId, type: _type, ...itemUpdates } = message;
      const item = await agentManager.updateKanbanItem(itemId, itemUpdates);
      if (item) {
        broadcast({ type: 'kanban_item_updated', item });
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Kanban item not found' }));
      }
      break;
    }

    case 'delete_kanban_item': {
      const deleted = await agentManager.deleteKanbanItem(message.id);
      if (deleted) {
        broadcast({ type: 'kanban_item_deleted', id: message.id });
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Kanban item not found' }));
      }
      break;
    }

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

// --- Xcode Simulator REST helpers ---

async function runSimctl(...args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(['xcrun', 'simctl', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { ok: exitCode === 0, output: stdout || stderr };
  } catch (e: any) {
    return { ok: false, output: e.message || 'xcrun not found. Is Xcode installed?' };
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const server = Bun.serve({
  port: 3333,

  routes: {
    '/': index,
  },

  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (req.headers.get('upgrade') === 'websocket') {
      const success = server.upgrade(req);
      if (success) return undefined;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // API: List directories
    if (url.pathname === '/api/directories') {
      const path = url.searchParams.get('path') || homedir();
      return listDirectories(path).then(dirs =>
        new Response(JSON.stringify({ path, directories: dirs, home: homedir() }), {
          headers: { 'Content-Type': 'application/json' }
        })
      );
    }

    // --- Xcode Simulator REST endpoints ---

    if (url.pathname === '/api/simulators' && req.method === 'GET') {
      return (async () => {
        const result = await runSimctl('list', 'devices', '--json');
        if (!result.ok) {
          return jsonResponse({ error: result.output, devices: {} }, 500);
        }
        try {
          const parsed = JSON.parse(result.output);
          return jsonResponse(parsed);
        } catch {
          return jsonResponse({ error: 'Failed to parse simctl output', raw: result.output }, 500);
        }
      })();
    }

    if (url.pathname === '/api/simulators/boot' && req.method === 'POST') {
      return (async () => {
        const body = await req.json() as { udid: string };
        if (!body.udid) return jsonResponse({ error: 'Missing udid' }, 400);
        const result = await runSimctl('boot', body.udid);
        return jsonResponse({ ok: result.ok, message: result.output });
      })();
    }

    if (url.pathname === '/api/simulators/shutdown' && req.method === 'POST') {
      return (async () => {
        const body = await req.json() as { udid: string };
        if (!body.udid) return jsonResponse({ error: 'Missing udid' }, 400);
        const result = await runSimctl('shutdown', body.udid);
        return jsonResponse({ ok: result.ok, message: result.output });
      })();
    }

    if (url.pathname === '/api/simulators/erase' && req.method === 'POST') {
      return (async () => {
        const body = await req.json() as { udid: string };
        if (!body.udid) return jsonResponse({ error: 'Missing udid' }, 400);
        const result = await runSimctl('erase', body.udid);
        return jsonResponse({ ok: result.ok, message: result.output });
      })();
    }

    if (url.pathname === '/api/simulators/clean-derived-data' && req.method === 'POST') {
      return (async () => {
        const derivedDataPath = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
        try {
          const proc = Bun.spawn(['rm', '-rf', derivedDataPath], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const exitCode = await proc.exited;
          const stderr = await new Response(proc.stderr).text();
          if (exitCode === 0) {
            return jsonResponse({ ok: true, message: 'Derived data cleaned' });
          }
          return jsonResponse({ ok: false, message: stderr || 'Failed to clean derived data' }, 500);
        } catch (e: any) {
          return jsonResponse({ ok: false, message: e.message }, 500);
        }
      })();
    }

    // 404 for other routes
    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      console.log('Client connected');

      // Send current state on connect
      const agents = agentManager.getAgents();
      ws.send(JSON.stringify({ type: 'agents_list', agents }));
      const notes = agentManager.getNotes();
      ws.send(JSON.stringify({ type: 'notes_list', notes }));
      const items = agentManager.getKanbanItems();
      ws.send(JSON.stringify({ type: 'kanban_list', items }));
    },

    message(ws, message) {
      try {
        const data = JSON.parse(message.toString()) as ClientMessage;
        handleMessage(ws, data);
      } catch (e) {
        console.error('Failed to parse message:', e);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    },

    close(ws) {
      clients.delete(ws);
      console.log('Client disconnected');
    },
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at http://localhost:${server.port}`);
