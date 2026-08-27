import { expect, test } from 'bun:test';
import { createCommandSession } from './command-session';

test('the same request ID is idempotent and a changed payload is rejected', () => {
  const session = createCommandSession({ serverSessionId: 'server-1' });
  const first = session.observe(
    { requestId: 'req-1', protocolVersion: 1, clientSessionId: 'tab-a' },
    { type: 'send_message', agentId: 'a1', content: 'hello' },
  );
  const retry = session.observe(
    { requestId: 'req-1', protocolVersion: 1, clientSessionId: 'tab-a' },
    { type: 'send_message', agentId: 'a1', content: 'hello' },
  );
  const conflict = session.observe(
    { requestId: 'req-1', protocolVersion: 1, clientSessionId: 'tab-b' },
    { type: 'send_message', agentId: 'a1', content: 'different' },
  );
  expect(first.status).toBe('accepted');
  expect(first.acceptedSequence).toBe(1);
  expect(retry.status).toBe('duplicate');
  expect(retry.acceptedSequence).toBe(1);
  expect(conflict.status).toBe('rejected');
  expect(conflict.reasonCode).toBe('request-id-conflict');
});

test('an unsupported protocol version is rejected without executing later work', () => {
  const session = createCommandSession();
  const ack = session.observe(
    { requestId: 'req-2', protocolVersion: 99 },
    { type: 'ping' },
  );
  expect(ack.status).toBe('rejected');
  expect(ack.reasonCode).toBe('unsupported-protocol');
});
