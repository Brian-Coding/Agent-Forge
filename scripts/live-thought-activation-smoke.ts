/**
 * Authenticated Claude/Codex activation smoke for Restore Live Thought.
 * Talks to a running Agent Forge over the local WebSocket.
 *
 *   bun scripts/live-thought-activation-smoke.ts
 *
 * PORT defaults to 3334 (to avoid colliding with the default server port 3333).
 */
const PORT = Number(process.env.PORT || 3334);
const WS_URL = `ws://127.0.0.1:${PORT}`;
const WORKSPACE_ID = process.env.WORKSPACE_ID || 'demo-workspace';
const TURN_MS = Number(process.env.SMOKE_TURN_MS || 180_000);

type Wire = Record<string, any>;

function stamp(label: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  console.log(`[smoke ${new Date().toISOString()}] ${label}${suffix}`);
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error(`connect timeout ${WS_URL}`)), 10_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`websocket error ${WS_URL}`));
    });
  });
}

function send(ws: WebSocket, message: Wire): void {
  ws.send(JSON.stringify(message));
}

function waitFor(ws: WebSocket, predicate: (msg: Wire) => boolean, timeoutMs: number, label: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`timeout waiting for ${label} (${timeoutMs}ms)`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      let msg: Wire;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve(msg);
    };
    ws.addEventListener('message', onMessage);
  });
}

function collectUntil(ws: WebSocket, done: (msg: Wire, bag: Wire[]) => boolean, timeoutMs: number, label: string): Promise<Wire[]> {
  return new Promise((resolve, reject) => {
    const bag: Wire[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`timeout collecting ${label} (${timeoutMs}ms); last types: ${bag.slice(-8).map(m => m.type).join(',')}`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      let msg: Wire;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      bag.push(msg);
      if (!done(msg, bag)) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve(bag);
    };
    ws.addEventListener('message', onMessage);
  });
}

function liveFor(agentId: string, bag: Wire[]): Wire[] {
  return bag.filter(m => m.type === 'live_turn_state' && m.state?.agentId === agentId);
}

function assistantMessages(agentId: string, bag: Wire[]): Wire[] {
  return bag.filter(m => m.type === 'message' && m.message?.agentId === agentId && m.message?.role === 'assistant');
}

function latestAgent(agentId: string, bag: Wire[]): Wire | undefined {
  return [...bag].reverse().find(m => m.type === 'agent_updated' && m.agent?.id === agentId)?.agent;
}

async function createAgent(ws: WebSocket, name: string, cwd: string): Promise<Wire> {
  send(ws, { type: 'create_agent', name, cwd, workspaceId: WORKSPACE_ID });
  const created = await waitFor(ws, m => m.type === 'agent_created' && m.agent?.name === name, 15_000, `create ${name}`);
  return created.agent;
}

async function main(): Promise<void> {
  const project = `${process.env.TEMP || process.env.TMP || '.'}\\agent-forge-live-thought-smoke-${Date.now()}`;
  await Bun.$`mkdir ${project}`.quiet();
  await Bun.write(`${project}\\README.md`, 'live-thought-smoke-ok\nThis file is the read-only target for the activation smoke.\n');
  stamp('project', project);

  const prompt = 'Read README.md in this working directory. Reply with only its first line. Do not edit files, do not create files, and do not run other tools.';

  let ws = await connect();
  stamp('connected', WS_URL);
  const hello = await waitFor(ws, m => m.type === 'agents_list', 10_000, 'agents_list');
  const existingIds = new Set((hello.agents ?? []).map((a: Wire) => a.id));
  stamp('existing-agents', hello.agents?.map((a: Wire) => ({ id: a.id, name: a.name, status: a.status })));

  const claude = await createAgent(ws, 'smoke-claude-live-thought', project);
  send(ws, { type: 'update_agent', id: claude.id, provider: 'claude', model: 'claude-opus-4-8' });
  const claudeUpdated = await waitFor(ws, m => m.type === 'agent_updated' && m.agent?.id === claude.id && m.agent?.provider === 'claude', 10_000, 'claude provider');
  stamp('claude-ready', { id: claude.id, provider: claudeUpdated.agent.provider, model: claudeUpdated.agent.model });

  const codex = await createAgent(ws, 'smoke-codex-live-thought', project);
  stamp('codex-ready', { id: codex.id, provider: codex.provider ?? 'codex', model: codex.model });

  const report: Record<string, unknown> = {
    port: PORT,
    project,
    claudeId: claude.id,
    codexId: codex.id,
  };

  try {
    // Claude: full turn + mid-turn reconnect
    send(ws, { type: 'send_message', agentId: claude.id, content: prompt });
    const firstLive = await waitFor(
      ws,
      m => m.type === 'live_turn_state' && m.state?.agentId === claude.id && m.state?.active === true
        && (m.state.phase !== 'starting' || m.state.thought || m.state.response || m.state.activity),
      90_000,
      'claude first live progress',
    );
    stamp('claude-live', { phase: firstLive.state.phase, turnId: firstLive.state.turnId, activity: firstLive.state.activity?.label });

    ws.close();
    ws = await connect();
    const reconnectSnap = await waitFor(
      ws,
      m => m.type === 'live_turn_state' && m.state?.agentId === claude.id,
      10_000,
      'claude reconnect live_turn_state',
    );
    stamp('claude-reconnect', {
      active: reconnectSnap.state.active,
      turnId: reconnectSnap.state.turnId,
      phase: reconnectSnap.state.phase,
      sameTurn: reconnectSnap.state.turnId === firstLive.state.turnId,
    });
    if (reconnectSnap.state.turnId !== firstLive.state.turnId) {
      throw new Error('reconnect restored a different turn id');
    }

    const claudeBag = await collectUntil(ws, (msg) => {
      const agent = msg.type === 'agent_updated' && msg.agent?.id === claude.id ? msg.agent : null;
      return Boolean(agent && (agent.status === 'idle' || agent.status === 'error' || agent.status === 'stopped') && agent.lastTurnOutcome);
    }, TURN_MS, 'claude turn complete');

    const claudeAgent = latestAgent(claude.id, claudeBag);
    const claudeLives = liveFor(claude.id, claudeBag);
    const claudeAssist = assistantMessages(claude.id, claudeBag);
    const claudeProgress = claudeLives.some(m => m.state.thought || m.state.response || m.state.activity || m.state.phase !== 'starting');
    const claudeErrors = claudeBag.filter(m => m.type === 'error' && m.agentId === claude.id).map(m => m.message);
    report.claude = {
      status: claudeAgent?.status,
      outcome: claudeAgent?.lastTurnOutcome,
      provider: claudeAgent?.provider,
      model: claudeAgent?.model,
      modelMismatch: claudeAgent?.modelMismatch ?? null,
      liveEvents: claudeLives.length,
      assistantMessages: claudeAssist.length,
      progress: claudeProgress,
      reconnectSameTurn: true,
      errors: claudeErrors,
      sample: claudeAssist.at(-1)?.message?.content?.slice(0, 200),
    };
    stamp('claude-done', report.claude);
    if (claudeAgent?.status !== 'idle') throw new Error(`claude ended ${claudeAgent?.status}`);
    if (claudeAgent?.lastTurnOutcome?.status !== 'completed') throw new Error(`claude outcome ${claudeAgent?.lastTurnOutcome?.status}`);
    if (claudeAgent?.modelMismatch) throw new Error('claude latched a model mismatch');
    if (!claudeProgress) throw new Error('claude produced no live thought/activity');
    if (claudeAssist.length !== 1) throw new Error(`claude assistant messages: ${claudeAssist.length}`);

    // Codex: start, queue a follow-up, stop, confirm queue does not run
    send(ws, { type: 'send_message', agentId: codex.id, content: prompt });
    const codexLive = await waitFor(
      ws,
      m => m.type === 'live_turn_state' && m.state?.agentId === codex.id && m.state?.active === true
        && (m.state.phase !== 'starting' || m.state.thought || m.state.response || m.state.activity),
      90_000,
      'codex first live progress',
    );
    stamp('codex-live', { phase: codexLive.state.phase, turnId: codexLive.state.turnId, activity: codexLive.state.activity?.label });
    send(ws, { type: 'send_message', agentId: codex.id, content: 'This queued follow-up must not start after stop.' });
    await Bun.sleep(400);
    send(ws, { type: 'stop_agent', agentId: codex.id });

    const codexBag = await collectUntil(ws, (msg) => {
      const agent = msg.type === 'agent_updated' && msg.agent?.id === codex.id ? msg.agent : null;
      return Boolean(agent && (agent.status === 'idle' || agent.status === 'stopped' || agent.status === 'error') && agent.lastTurnOutcome);
    }, 90_000, 'codex stop complete');

    await Bun.sleep(4_000);
    send(ws, { type: 'list_agents' });
    const listed = await waitFor(ws, m => m.type === 'agents_list', 8_000, 'list after stop');
    const codexAfter = (listed.agents as Wire[]).find(a => a.id === codex.id);
    const codexAgent = latestAgent(codex.id, codexBag);
    const queuedStarted = assistantMessages(codex.id, codexBag).some(m => String(m.message?.content ?? '').includes('queued follow-up'));
    report.codex = {
      status: codexAfter?.status ?? codexAgent?.status,
      outcome: codexAfter?.lastTurnOutcome ?? codexAgent?.lastTurnOutcome,
      provider: codexAfter?.provider ?? codexAgent?.provider,
      model: codexAfter?.model ?? codexAgent?.model,
      modelMismatch: codexAfter?.modelMismatch ?? null,
      liveEvents: liveFor(codex.id, codexBag).length,
      queuedFollowUpStarted: queuedStarted,
    };
    stamp('codex-stopped', report.codex);
    const outcome = (codexAfter?.lastTurnOutcome ?? codexAgent?.lastTurnOutcome)?.status;
    if (outcome !== 'stopped') throw new Error(`codex outcome ${outcome}`);
    if (codexAfter?.status === 'working' || codexAfter?.status === 'thinking') throw new Error('codex still working after stop');
    if (queuedStarted) throw new Error('queued follow-up started after stop');

    const claudeProcs = await Bun.$`tasklist /FI "IMAGENAME eq claude.exe" /NH`.nothrow().text();
    const codexProcs = await Bun.$`tasklist /FI "IMAGENAME eq codex.exe" /NH`.nothrow().text();
    report.claudeProcesses = claudeProcs.includes('claude.exe') ? claudeProcs.trim() : 'none';
    report.codexProcesses = codexProcs.includes('codex.exe') ? codexProcs.trim() : 'none';
    stamp('process-scan-done');
  } finally {
    try {
      send(ws, { type: 'remove_agent', agentId: claude.id });
      send(ws, { type: 'remove_agent', agentId: codex.id });
      await Bun.sleep(500);
    } catch {}
    try { ws.close(); } catch {}
    try { await Bun.$`rm -rf ${project}`.quiet(); } catch {}
    const leftover = existingIds;
    leftover.delete(claude.id);
    leftover.delete(codex.id);
  }

  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
}

await main();
