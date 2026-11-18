import type { ServerWebSocket } from 'bun';
import type { ClientMessage } from '../shared/protocol';
import { clients, clientLastPong, broadcast, sendTo } from './broadcast';
import { agentService } from './services/agent.service';
import { settingsService } from './services/settings.service';
import { workspaceService } from './services/workspace.service';
import { terminalService } from './services/terminal.service';
import { chatService } from './services/chat.service';
import { usageService } from './services/usage.service';
import { limitsService } from './services/limits.service';
import { liveTurnStateService } from './services/live-turn-state.service';
import {
  ClientMessageValidationError,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  parseClientCommand,
} from './client-message';
import { chatSendPreview, commandQueue, isChatSendCommand, MAX_COMMAND_QUEUE_DEPTH, setCommandQueueListener } from './services/command-queue';
import { commandSession } from './services/command-session';
import { peekRuntimeCompact } from './services/runtime-truth';
import { authRecoveryStore, setAuthRecoveryListener } from './auth/auth-recovery';

setAuthRecoveryListener(snapshot => broadcast(snapshot));

setCommandQueueListener(snapshot => broadcast(snapshot));

// WebSocket heartbeat — ping every 30s, close stale clients after 40s.
// Keep one timer across module reloads; its proxy invokes the newest callback
// so HMR cannot accumulate duplicate pings and cleanup attempts.
export function runWebSocketHeartbeat(now = Date.now()): void {
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
}

(globalThis as any).__websocketHeartbeatTick = runWebSocketHeartbeat;
if (!(globalThis as any).__websocketHeartbeatTimer) {
  const timer = setInterval(() => (globalThis as any).__websocketHeartbeatTick(), 30_000);
  timer.unref?.();
  (globalThis as any).__websocketHeartbeatTimer = timer;
}

// Handle incoming WebSocket messages
async function handleMessage(ws: ServerWebSocket<unknown>, message: ClientMessage) {
  switch (message.type) {
    case 'ping': {
      sendTo(ws, { type: 'pong' });
      break;
    }

    case 'get_command_queue': {
      for (const snapshot of commandQueue.snapshots()) sendTo(ws, snapshot);
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

    case 'resolve_model_mismatch': {
      // Two explicit resolutions for a latched model mismatch:
      //   'continue-actual'  — adopt the model that really ran, keep the session
      //   'fresh-requested'  — keep the selection, drop the session, spawn fresh
      const action = message.action === 'continue-actual' ? 'continue-actual' : 'fresh-requested';
      const agent = await agentService.resolveModelMismatch(message.id, action);
      if (!agent) {
        sendTo(ws, { type: 'error', message: 'Agent not found', agentId: message.id });
      }
      break;
    }

    case 'send_message': {
      try {
        await chatService.sendMessage(message.agentId, message.content);
      } catch (e: any) {
        sendTo(ws, {
          type: 'error',
          message: e?.message || 'Message could not be completed or persisted',
          agentId: message.agentId,
        });
      }
      break;
    }

    case 'check_auth': {
      const agent = agentService.getAgent(message.agentId);
      if (!agent) {
        sendTo(ws, { type: 'error', message: 'Agent not found', agentId: message.agentId });
        break;
      }
      try {
        await authRecoveryStore.checkAgain(message.agentId, agent.provider ?? 'claude');
      } catch (e: any) {
        sendTo(ws, { type: 'error', message: e?.message || 'Auth check failed', agentId: message.agentId });
      }
      break;
    }

    case 'retry_auth_prompt': {
      const decision = authRecoveryStore.canRetry(message.agentId, message.incidentId, message.confirmSideEffects === true);
      if (!decision.ok) {
        sendTo(ws, { type: 'error', message: decision.userMessage, agentId: message.agentId });
        break;
      }
      const original = agentService.getMessages(message.agentId)
        .find(item => item.id === decision.incident.messageId && item.role === 'user');
      if (!original) {
        sendTo(ws, { type: 'error', message: 'The preserved prompt is no longer in this chat.', agentId: message.agentId });
        break;
      }
      try {
        await chatService.sendMessage(message.agentId, original.content, {
          imageAttachments: original.imageAttachments,
        });
      } catch (e: any) {
        sendTo(ws, {
          type: 'error',
          message: e?.message || 'Preserved prompt could not be retried',
          agentId: message.agentId,
        });
      }
      break;
    }

    case 'stop_agent': {
      commandQueue.reset(message.agentId);
      const success = await agentService.stopAgent(message.agentId);
      if (!success) {
        sendTo(ws, { type: 'error', message: 'Agent not found', agentId: message.agentId });
      }
      break;
    }

    case 'kill_agent': {
      commandQueue.reset(message.agentId);
      const success = await agentService.killAgent(message.agentId);
      if (!success) {
        sendTo(ws, { type: 'error', message: 'Agent not found', agentId: message.agentId });
      }
      break;
    }

    case 'remove_agent': {
      commandQueue.reset(message.agentId);
      authRecoveryStore.clearAgent(message.agentId);
      const success = await agentService.removeAgent(message.agentId);
      if (success) {
        liveTurnStateService.clear(message.agentId);
        broadcast({ type: 'agent_removed', agentId: message.agentId });
        broadcast({ type: 'workspaces_list', workspaces: workspaceService.getAll() });
      } else {
        sendTo(ws, { type: 'error', message: 'Agent not found', agentId: message.agentId });
      }
      break;
    }

    case 'clear_history': {
      authRecoveryStore.clearAgent(message.agentId);
      const success = await agentService.clearHistory(message.agentId);
      if (success) {
        if (!liveTurnStateService.get(message.agentId)?.active) {
          liveTurnStateService.clear(message.agentId);
        }
        broadcast({ type: 'history_cleared', agentId: message.agentId });
      }
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
      const liveState = liveTurnStateService.get(message.agentId);
      if (liveState) sendTo(ws, { type: 'live_turn_state', state: liveState });
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

    case 'send_uploaded_images': {
      await agentService.sendUploadedImages(message.agentId, message.images, message.prompt);
      break;
    }

    // --- Workspaces ---
    case 'get_workspaces': {
      sendTo(ws, { type: 'workspaces_list', workspaces: workspaceService.getAll() });
      break;
    }

    case 'create_workspace': {
      const workspace = await workspaceService.create(message.name, message.cwd);
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

    case 'reorder_workspaces': {
      const ordered = await workspaceService.reorder(message.orderedIds);
      broadcast({ type: 'workspaces_list', workspaces: ordered });
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

    case 'refresh_limits': {
      try {
        await limitsService.refresh(true, { force: true });
      } catch (e: any) {
        sendTo(ws, { type: 'error', message: e?.message || 'Limits refresh failed' });
      }
      break;
    }

    case 'kill_all': {
      await agentService.killAllProcesses();
      await terminalService.killAll();
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
  maxPayloadLength: MAX_WEBSOCKET_MESSAGE_BYTES,

  open(ws: ServerWebSocket<unknown>) {
    clients.add(ws);
    clientLastPong.set(ws, Date.now());
    console.log('Client connected');

    // Send current state on connect
    sendTo(ws, {
      type: 'server_session',
      serverSessionId: commandSession.serverSessionId,
      ...peekRuntimeCompact() ?? {},
    });
    sendTo(ws, { type: 'agents_list', agents: agentService.getAgents() });
    sendTo(ws, { type: 'settings', settings: settingsService.get() });
    sendTo(ws, { type: 'workspaces_list', workspaces: workspaceService.getAll() });
    sendTo(ws, { type: 'terminals_list', terminals: terminalService.getAll() });
    // Cross-provider token report — drives the Tokens sidebar tab.
    sendTo(ws, { type: 'usage_report', report: usageService.getReportForConnect() });
    // Provider limits — cached snapshot on connect (the one-minute loop keeps it fresh).
    const limitsSnapshot = limitsService.getSnapshot();
    if (limitsSnapshot) sendTo(ws, { type: 'limits_snapshot', snapshot: limitsSnapshot });
    for (const state of liveTurnStateService.getAll()) {
      sendTo(ws, { type: 'live_turn_state', state });
    }

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
    for (const snapshot of commandQueue.snapshots()) sendTo(ws, snapshot);
    sendTo(ws, authRecoveryStore.snapshot());
  },

  message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
    try {
      const parsed = parseClientCommand(message);
      const dispatch = async () => {
        if (parsed.meta.requestId) {
          const observed = commandSession.observe(parsed.meta, parsed.message);
          if (observed.status !== 'accepted') {
            sendTo(ws, observed);
            return;
          }
          if (parsed.message.type === 'retry_auth_prompt') {
            const decision = authRecoveryStore.canRetry(
              parsed.message.agentId,
              parsed.message.incidentId,
              parsed.message.confirmSideEffects === true,
            );
            if (!decision.ok) {
              sendTo(ws, commandSession.reject(observed.requestId, decision.reasonCode, decision.userMessage));
              return;
            }
          }
          if (isChatSendCommand(parsed.message)) {
            const agentId = parsed.message.agentId;
            const item = commandQueue.enqueue(
              agentId,
              observed.requestId,
              observed.acceptedSequence ?? 0,
              chatSendPreview(parsed.message),
              () => handleMessage(ws, parsed.message),
            );
            if (!item) {
              sendTo(ws, commandSession.reject(
                observed.requestId,
                'queue-full',
                `Agent command queue is full (${MAX_COMMAND_QUEUE_DEPTH})`,
              ));
              return;
            }
            sendTo(ws, { ...observed, queuePosition: commandQueue.size(agentId) });
            return;
          }
          await handleMessage(ws, parsed.message);
          sendTo(ws, observed);
          return;
        }
        await handleMessage(ws, parsed.message);
      };
      dispatch().catch(e => {
        console.error('handleMessage error:', e);
        sendTo(ws, {
          type: 'error',
          message: e instanceof Error ? e.message : 'WebSocket request failed',
        });
      });
    } catch (e) {
      const detail = e instanceof ClientMessageValidationError ? e.message : 'Invalid WebSocket message';
      console.error('Rejected WebSocket message:', detail);
      sendTo(ws, { type: 'error', message: detail });
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
