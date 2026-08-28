import type { ServerWebSocket } from 'bun';
import type { ServerMessage } from '../shared/protocol';
import { createOutboundBuffer, type OutboundBuffer } from './services/outbound-events';

// Shared WebSocket client tracking — used by ws.ts for setup, services for sending
export const clients = new Set<ServerWebSocket<unknown>>();
export const clientLastPong = new Map<ServerWebSocket<unknown>, number>();
const outboxes = new WeakMap<ServerWebSocket<unknown>, OutboundBuffer>();

function outboxFor(ws: ServerWebSocket<unknown>): OutboundBuffer {
  const existing = outboxes.get(ws);
  if (existing) return existing;
  const created = createOutboundBuffer();
  outboxes.set(ws, created);
  return created;
}

/** Broadcast a message to all connected WebSocket clients */
export function broadcast(message: ServerMessage): void {
  for (const client of [...clients]) sendTo(client, message);
}

/** Send a message to a single WebSocket client */
export function sendTo(ws: ServerWebSocket<unknown>, message: ServerMessage): void {
  const box = outboxFor(ws);
  const { disconnect } = box.enqueue(message);
  if (disconnect) {
    try { ws.close(); } catch {}
    clients.delete(ws);
    return;
  }
  try {
    box.flush(data => ws.send(data));
  } catch {
    clients.delete(ws);
  }
}
