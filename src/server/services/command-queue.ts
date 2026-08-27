import { randomUUID } from 'crypto';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { commandSession } from './command-session';

export const MAX_COMMAND_QUEUE_DEPTH = 16;
const PREVIEW_CHARS = 120;

export interface CommandQueueItem {
  itemId: string;
  requestId: string;
  agentId: string;
  status: 'queued' | 'running';
  preview: string;
  acceptedSequence: number;
  job: () => Promise<void>;
}

export interface CommandQueue {
  enqueue(agentId: string, requestId: string, acceptedSequence: number, preview: string, job: () => Promise<void>): CommandQueueItem | null;
  snapshot(agentId: string): Extract<ServerMessage, { type: 'command_queue' }>;
  snapshots(): Array<Extract<ServerMessage, { type: 'command_queue' }>>;
  size(agentId: string): number;
  reset(agentId: string): void;
}

function previewFrom(message: ClientMessage): string {
  if ('content' in message && typeof message.content === 'string') return message.content.slice(0, PREVIEW_CHARS);
  if (message.type === 'send_image' || message.type === 'send_images' || message.type === 'send_uploaded_images') {
    return message.prompt?.slice(0, PREVIEW_CHARS) || '[image]';
  }
  if (message.type === 'retry_auth_prompt') return 'Retry preserved prompt';
  return message.type;
}

export function chatSendPreview(message: ClientMessage): string {
  return previewFrom(message);
}

export function isChatSendCommand(message: ClientMessage): message is ClientMessage & { agentId: string } {
  return message.type === 'send_message'
    || message.type === 'send_image'
    || message.type === 'send_images'
    || message.type === 'send_uploaded_images'
    || message.type === 'retry_auth_prompt';
}

export function createCommandQueue(options: {
  onChange?: (snapshot: Extract<ServerMessage, { type: 'command_queue' }>) => void;
} = {}): CommandQueue {
  const items = new Map<string, CommandQueueItem[]>();
  const pumping = new Set<string>();

  const snapshot = (agentId: string): Extract<ServerMessage, { type: 'command_queue' }> => ({
    type: 'command_queue',
    serverSessionId: commandSession.serverSessionId,
    agentId,
    items: (items.get(agentId) ?? []).map(item => ({
      itemId: item.itemId,
      requestId: item.requestId,
      status: item.status,
      preview: item.preview,
      acceptedSequence: item.acceptedSequence,
    })),
  });

  const notify = (agentId: string) => options.onChange?.(snapshot(agentId));

  const pump = async (agentId: string) => {
    if (pumping.has(agentId)) return;
    pumping.add(agentId);
    try {
      while (true) {
        const queue = items.get(agentId) ?? [];
        const next = queue.find(item => item.status === 'queued');
        if (!next) return;
        next.status = 'running';
        notify(agentId);
        try {
          await next.job();
        } catch (error) {
          console.error(`[command-queue] job failed for ${agentId}:`, error);
        }
        const live = items.get(agentId) ?? [];
        items.set(agentId, live.filter(item => item.itemId !== next.itemId));
        notify(agentId);
      }
    } finally {
      pumping.delete(agentId);
    }
  };

  return {
    enqueue(agentId, requestId, acceptedSequence, preview, job) {
      const queue = items.get(agentId) ?? [];
      if (queue.length >= MAX_COMMAND_QUEUE_DEPTH) return null;
      const item: CommandQueueItem = {
        itemId: randomUUID(),
        requestId,
        agentId,
        status: 'queued',
        preview,
        acceptedSequence,
        job,
      };
      items.set(agentId, [...queue, item]);
      notify(agentId);
      void pump(agentId);
      return item;
    },
    snapshot,
    snapshots() {
      return [...items.keys()].map(snapshot);
    },
    size(agentId) {
      return (items.get(agentId) ?? []).length;
    },
    reset(agentId) {
      items.delete(agentId);
      notify(agentId);
    },
  };
}

type QueueListener = (snapshot: Extract<ServerMessage, { type: 'command_queue' }>) => void;
let queueListener: QueueListener | undefined;

export function setCommandQueueListener(listener: QueueListener): void {
  queueListener = listener;
}

export const commandQueue: CommandQueue = (globalThis as any).__commandQueue ??= createCommandQueue({
  onChange: snapshot => queueListener?.(snapshot),
});
(globalThis as any).__commandQueue = commandQueue;
