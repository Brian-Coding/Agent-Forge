import { expect, test } from 'bun:test';
import { classifyServerMessage, createOutboundBuffer } from './outbound-events';

test('critical events never share a coalesce key and snapshots replace older copies', () => {
  expect(classifyServerMessage({ type: 'command_ack', protocolVersion: 1, requestId: 'r', status: 'accepted', serverSessionId: 's' })).toBe('critical');
  expect(classifyServerMessage({ type: 'agents_list', agents: [] })).toBe('snapshot');
  const box = createOutboundBuffer();
  box.enqueue({ type: 'thinking_output', agentId: 'a1', content: 'old' });
  box.enqueue({ type: 'thinking_output', agentId: 'a1', content: 'new' });
  const sent: string[] = [];
  box.flush(data => sent.push(data));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!).content).toBe('new');
  expect(box.metrics.coalesced).toBe(1);
});

test('overflow drops replaceable events and disconnects if only critical remain', () => {
  const box = createOutboundBuffer({ maxItems: 2, maxBytes: 10_000 });
  box.enqueue({ type: 'command_ack', protocolVersion: 1, requestId: 'a', status: 'accepted', serverSessionId: 's' });
  box.enqueue({ type: 'thinking_output', agentId: 'a1', content: 'x'.repeat(20) });
  box.enqueue({ type: 'thinking_output', agentId: 'a2', content: 'y'.repeat(20) });
  expect(box.size()).toBe(2);
  expect(box.metrics.dropped).toBe(1);
  const full = createOutboundBuffer({ maxItems: 1, maxBytes: 10_000 });
  full.enqueue({ type: 'command_ack', protocolVersion: 1, requestId: 'a', status: 'accepted', serverSessionId: 's' });
  const overflow = full.enqueue({ type: 'command_ack', protocolVersion: 1, requestId: 'b', status: 'accepted', serverSessionId: 's' });
  expect(overflow.disconnect).toBe(true);
  expect(full.metrics.disconnected).toBe(1);
});
