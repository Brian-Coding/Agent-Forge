import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = source.indexOf('    function useWebSocket() {');
const end = source.indexOf('    // ======================== COMPONENTS', start);
if (start < 0 || end < start) throw new Error('Could not locate the browser WebSocket hook');

// Execute the shipped hook with controlled renders and transport events. In
// particular, several server frames may arrive before React renders again.
function mountClient() {
  const slots: any[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const sockets: FakeSocket[] = [];
  let client: any;

  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent: any[] = [];
    attempts: any[] = [];
    failNextSend = false;
    onopen = () => {};
    onclose = () => {};
    onmessage = (_event: { data: string }) => {};
    constructor(_url: string) { sockets.push(this); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose(); }
    send(data: string) {
      this.attempts.push(JSON.parse(data));
      if (this.failNextSend) {
        this.failNextSend = false;
        throw new Error('Transport closed during send');
      }
      this.sent.push(JSON.parse(data));
    }
    receive(message: any) { this.onmessage({ data: JSON.stringify(message) }); }
  }

  function memo(factory: () => any, dependencies: any[]) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      slots[index] = { value: factory(), dependencies };
    }
    return slots[index].value;
  }

  const dependencies = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (update: any) => {
        slots[index] = typeof update === 'function' ? update(slots[index]) : update;
      }];
    },
    useRef(initial: any) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useCallback: (callback: any, deps: any[]) => memo(() => callback, deps),
    useEffect(effect: () => any, deps: any[]) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies: deps, cleanup: effect() };
        });
      }
    },
    readStoredActiveWorkspaceId: () => null,
    storeActiveWorkspaceId: () => {},
    AGENT_PROVIDERS: [],
    sessionStorage: { getItem: () => 'queue-test-tab' },
    WebSocket: FakeSocket,
    location: { protocol: 'http:', host: 'queue-test.invalid' },
    fetch: async () => ({ ok: false }),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  const hook = new Function(...Object.keys(dependencies), `${source.slice(start, end)}; return useWebSocket;`)(
    ...Object.values(dependencies),
  );
  function render() {
    cursor = 0;
    client = hook();
    const pendingEffects = effects;
    effects = [];
    pendingEffects.forEach(effect => effect());
    return client;
  }
  render();
  return {
    render,
    get client() { return client; },
    get socket() { return sockets.at(-1)!; },
    get sends() { return sockets.flatMap(socket => socket.sent).filter(frame => frame.type === 'send_message'); },
    reconnect() {
      if (this.socket.readyState !== 3) this.socket.close();
      const pendingTimers = [...timers.values()];
      timers.clear();
      pendingTimers.forEach(callback => callback());
      this.socket.open();
    },
  };
}

const agent = { id: 'agent-a', name: 'Agent A', status: 'idle' };
const idle = { type: 'agent_updated', agent };
const agents = { type: 'agents_list', agents: [agent] };
function queueSnapshot(preview: string, agentId = agent.id) {
  return {
    type: 'command_queue', agentId, serverSessionId: 'queue-test-server',
    items: [{ itemId: 'item-1', requestId: 'server-request', status: 'queued', preview, acceptedSequence: 1 }],
  };
}

test('a server queue preview followed by repeated idle frames never resubmits a user turn', () => {
  const app = mountClient();
  app.socket.open();
  app.socket.receive(agents);
  app.render();
  app.client.sendMessage(agent.id, 'ok i restarted and I see Astra, good job');
  const originalSend = app.sends[0];

  // Server snapshots can arrive before its running status, or remain visible
  // until after finalization publishes idle. Neither ordering grants a send.
  for (let turn = 0; turn < 3; turn++) {
    app.socket.receive(queueSnapshot(originalSend.content));
    app.render();
    app.socket.receive(idle);
    app.socket.receive(idle);
    app.render();
    app.socket.receive(agents);
    app.render();
  }
  expect(app.sends).toEqual([originalSend]);
});

test('reconnecting to another client’s server queue only displays its preview', () => {
  const app = mountClient();
  app.socket.open();
  app.socket.receive(queueSnapshot('accepted in another tab'));
  expect(app.render().queued[agent.id]).toEqual(['accepted in another tab']);
  app.socket.receive(agents);
  app.render();
  app.reconnect();
  app.socket.receive(agents);
  app.socket.receive(queueSnapshot('accepted in another tab'));
  app.render();
  app.socket.receive(idle);
  expect(app.sends).toEqual([]);
});

test('offline messages survive server snapshots and flush in full once even when the agent is busy', () => {
  const app = mountClient();
  const fullContent = 'A long offline prompt '.repeat(20);
  app.client.sendMessage(agent.id, fullContent);
  app.client.sendMessage(agent.id, 'second offline prompt');
  app.socket.receive(queueSnapshot('server preview'));
  expect(app.render().queued[agent.id]).toEqual(['server preview', fullContent, 'second offline prompt']);
  app.socket.receive(idle); // A buffered status cannot consume offline work.
  expect(app.sends).toEqual([]);

  app.socket.open();
  app.socket.receive(queueSnapshot('server preview'));
  const busyAgents = { type: 'agents_list', agents: [{ ...agent, status: 'working' }] };
  app.socket.receive(busyAgents);
  app.socket.receive(busyAgents); // Back-to-back before any render.
  expect(app.sends.map(frame => frame.content)).toEqual([fullContent, 'second offline prompt']);
  expect(new Set(app.sends.map(frame => frame.requestId)).size).toBe(2);
  expect(app.render().queued[agent.id]).toEqual(['server preview']);
  app.socket.receive(idle);
  app.reconnect();
  app.socket.receive(agents);
  expect(app.sends).toHaveLength(2);
});

test('a failed socket write retains the prompt and its request ID for reconnect', () => {
  const app = mountClient();
  app.socket.open();
  app.socket.receive(agents);
  app.render();
  app.socket.failNextSend = true;
  expect(() => app.client.sendMessage(agent.id, 'keep this prompt')).not.toThrow();
  const attempt = app.socket.attempts.find(frame => frame.type === 'send_message');
  expect(app.render().queued[agent.id]).toEqual(['keep this prompt']);
  app.reconnect();
  app.socket.receive(agents);
  expect(app.sends).toHaveLength(1);
  expect(app.sends[0]).toMatchObject({ content: 'keep this prompt', requestId: attempt.requestId });
});

test('two intentional submissions of the same text remain distinct requests', () => {
  const app = mountClient();
  app.socket.open();
  app.client.sendMessage(agent.id, 'same text');
  app.client.sendMessage(agent.id, 'same text');
  expect(app.sends.map(frame => frame.content)).toEqual(['same text', 'same text']);
  expect(app.sends[0].requestId).not.toBe(app.sends[1].requestId);
});

test('stop, kill and remove cancel only that agent’s unsent prompts before reconnect', () => {
  for (const action of ['stopAgent', 'killAgent', 'removeAgent']) {
    const app = mountClient();
    app.client.sendMessage(agent.id, 'cancel this');
    app.client.sendMessage('agent-b', 'keep this');
    app.client[action](agent.id);
    expect(app.render().queued[agent.id] || []).toEqual([]);
    app.socket.open();
    app.socket.receive({ type: 'agents_list', agents: [agent, { ...agent, id: 'agent-b' }] });
    expect(app.sends.map(frame => [frame.agentId, frame.content])).toEqual([['agent-b', 'keep this']]);
  }
});

test('kill all and server agent removal cannot leave offline prompts to resurrect later', () => {
  const app = mountClient();
  app.client.sendMessage(agent.id, 'removed agent prompt');
  app.socket.receive(queueSnapshot('removed server preview'));
  app.socket.receive({ type: 'agent_removed', agentId: agent.id });
  expect(app.render().queued[agent.id]).toBeUndefined();
  app.socket.open();
  app.socket.receive(agents);
  expect(app.sends).toEqual([]);

  app.socket.close();
  app.client.sendMessage(agent.id, 'cancel all A');
  app.client.sendMessage('agent-b', 'cancel all B');
  app.client.killAll();
  app.reconnect();
  app.socket.receive({ type: 'agents_list', agents: [agent, { ...agent, id: 'agent-b' }] });
  expect(app.sends).toEqual([]);
});

test('reconnect discards stale server previews but retains locally unsent prompts', () => {
  const app = mountClient();
  app.socket.open();
  app.socket.receive(queueSnapshot('old server session'));
  app.render();
  app.socket.close();
  app.client.sendMessage(agent.id, 'still local');
  app.reconnect();
  expect(app.render().queued[agent.id]).toEqual(['still local']);
  app.socket.receive(agents);
  expect(app.sends.map(frame => frame.content)).toEqual(['still local']);
  expect(app.render().queued[agent.id] || []).toEqual([]);
});
