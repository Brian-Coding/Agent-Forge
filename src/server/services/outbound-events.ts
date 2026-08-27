import type { ServerMessage } from '../../shared/protocol';

export type OutboundEventClass = 'critical' | 'snapshot' | 'stream' | 'progress' | 'diagnostic';

export interface OutboundMetrics {
  sent: number;
  coalesced: number;
  dropped: number;
  disconnected: number;
}

const MAX_ITEMS = 100;
const MAX_BYTES = 256 * 1024;

export function classifyServerMessage(message: ServerMessage): OutboundEventClass {
  switch (message.type) {
    case 'command_ack':
    case 'command_queue':
    case 'error':
    case 'message':
    case 'history_cleared':
    case 'agent_removed':
    case 'server_session':
      return 'critical';
    case 'agents_list':
    case 'settings':
    case 'workspaces_list':
    case 'terminals_list':
    case 'history':
    case 'shared_context':
    case 'usage_report':
    case 'limits_snapshot':
      return 'snapshot';
    case 'output':
    case 'thinking_output':
    case 'live_turn_state':
    case 'terminal_output':
      return 'stream';
    case 'token_usage':
    case 'agent_activity':
    case 'agent_updated':
    case 'file_changed':
      return 'progress';
    default:
      return 'diagnostic';
  }
}

export function coalesceKey(message: ServerMessage): string | null {
  const eventClass = classifyServerMessage(message);
  if (eventClass === 'critical') return null;
  if (message.type === 'live_turn_state') return `live:${message.state.agentId}`;
  if (message.type === 'output') return `output:${message.agentId}:${message.stream}`;
  if (message.type === 'thinking_output') return `think:${message.agentId}`;
  if (message.type === 'token_usage') return `tokens:${message.agentId}`;
  if (message.type === 'agent_activity') return `activity:${message.agentId}`;
  if (message.type === 'file_changed') return `files:${message.agentId}`;
  if (message.type === 'terminal_output') return `term:${message.terminalId}`;
  return message.type;
}

export function createOutboundBuffer(options: { maxItems?: number; maxBytes?: number } = {}) {
  const maxItems = options.maxItems ?? MAX_ITEMS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const items: Array<{ message: ServerMessage; key: string | null; bytes: number }> = [];
  const metrics: OutboundMetrics = { sent: 0, coalesced: 0, dropped: 0, disconnected: 0 };
  let scheduled = false;

  const bytes = () => items.reduce((sum, item) => sum + item.bytes, 0);

  return {
    metrics,
    get scheduled() { return scheduled; },
    set scheduled(value: boolean) { scheduled = value; },
    size() { return items.length; },
    enqueue(message: ServerMessage): { disconnect: boolean } {
      const encoded = JSON.stringify(message);
      const key = coalesceKey(message);
      if (key) {
        const existing = items.findIndex(item => item.key === key);
        if (existing >= 0) {
          items.splice(existing, 1);
          metrics.coalesced += 1;
        }
      }
      items.push({ message, key, bytes: Buffer.byteLength(encoded, 'utf8') });
      while (items.length > maxItems || bytes() > maxBytes) {
        const dropAt = items.findIndex(item => classifyServerMessage(item.message) !== 'critical');
        if (dropAt < 0) {
          metrics.disconnected += 1;
          items.length = 0;
          return { disconnect: true };
        }
        items.splice(dropAt, 1);
        metrics.dropped += 1;
      }
      return { disconnect: false };
    },
    flush(send: (data: string) => void): void {
      const pending = items.splice(0);
      for (const item of pending) {
        send(JSON.stringify(item.message));
        metrics.sent += 1;
      }
    },
  };
}

export type OutboundBuffer = ReturnType<typeof createOutboundBuffer>;
