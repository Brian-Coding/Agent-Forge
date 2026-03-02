import type { ServerWebSocket } from 'bun';
import type { ServerMessage } from '../shared/protocol';

// Shared WebSocket client tracking — used by ws.ts for setup, services for sending
export const clients = new Set<ServerWebSocket<unknown>>();
export const clientLastPong = new Map<ServerWebSocket<unknown>, number>();

/** Broadcast a message to all connected WebSocket clients */
export function broadcast(message: ServerMessage): void {
  const data = JSON.stringify(message);
  for (const client of clients) {
    try {
      client.send(data);
    } catch (e) {
      clients.delete(client);
    }
  }
}

/** Send a message to a single WebSocket client */
export function sendTo(ws: ServerWebSocket<unknown>, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}
