import { createHash, randomUUID } from 'crypto';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import type { ClientCommandMeta } from '../client-message';

export const COMMAND_PROTOCOL_VERSION = 1;
const MAX_IDEMPOTENCY_ENTRIES = 512;
const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;

export type CommandAck = Extract<ServerMessage, { type: 'command_ack' }>;

interface IdempotencyEntry {
  payloadHash: string;
  ack: CommandAck;
  expiresAt: number;
}

export function hashCommandPayload(message: ClientMessage): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

export function createCommandSession(options: { now?: () => number; serverSessionId?: string } = {}) {
  const now = options.now ?? Date.now;
  const serverSessionId = options.serverSessionId ?? randomUUID();
  const entries = new Map<string, IdempotencyEntry>();
  let acceptedSequence = 0;

  const prune = () => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
    while (entries.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (!oldest) break;
      entries.delete(oldest);
    }
  };

  const ack = (
    requestId: string,
    status: CommandAck['status'],
    extras: Partial<CommandAck> = {},
  ): CommandAck => ({
    type: 'command_ack',
    protocolVersion: COMMAND_PROTOCOL_VERSION,
    requestId,
    status,
    serverSessionId,
    ...extras,
  });

  return {
    serverSessionId,

    observe(meta: ClientCommandMeta, message: ClientMessage): CommandAck {
      prune();
      const requestId = meta.requestId || randomUUID();
      if (meta.protocolVersion !== undefined && meta.protocolVersion !== COMMAND_PROTOCOL_VERSION) {
        return ack(requestId, 'rejected', {
          reasonCode: 'unsupported-protocol',
          userMessage: `Unsupported command protocol version ${meta.protocolVersion}`,
        });
      }
      const payloadHash = hashCommandPayload(message);
      const existing = meta.requestId ? entries.get(meta.requestId) : undefined;
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          return ack(requestId, 'rejected', {
            reasonCode: 'request-id-conflict',
            userMessage: 'This request ID was already used with a different command',
          });
        }
        return { ...existing.ack, status: 'duplicate' };
      }
      acceptedSequence += 1;
      const accepted = ack(requestId, 'accepted', { acceptedSequence });
      if (meta.requestId) {
        entries.set(meta.requestId, {
          payloadHash,
          ack: accepted,
          expiresAt: now() + IDEMPOTENCY_TTL_MS,
        });
      }
      return accepted;
    },

    reject(requestId: string, reasonCode: string, userMessage: string): CommandAck {
      const rejected = ack(requestId, 'rejected', { reasonCode, userMessage });
      const existing = entries.get(requestId);
      if (existing) existing.ack = rejected;
      return rejected;
    },
  };
}

export type CommandSession = ReturnType<typeof createCommandSession>;

export const commandSession: CommandSession = (globalThis as any).__commandSession ??= createCommandSession();
(globalThis as any).__commandSession = commandSession;
