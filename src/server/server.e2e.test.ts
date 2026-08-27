import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a TCP port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function drain(stream: ReadableStream<Uint8Array>, maxChars = 128_000): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      if (output.length > maxChars) output = output.slice(-maxChars);
    }
    return output + decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function waitForServer(baseUrl: string, proc: ReturnType<typeof Bun.spawn>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Server exited during startup with code ${proc.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/harness/instructions`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

async function waitForFrame(
  frames: any[],
  predicate: (frame: any) => boolean,
  timeoutMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for WebSocket frame');
}

test('full server boot recovers state, enforces transport guards, persists a mutation, and shuts down cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-e2e-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const workspaceId = `restart-${randomUUID()}`;
  const qaRunId = `qa-${randomUUID()}`;
  const atlasRunId = `atlas-${randomUUID()}`;
  const now = Date.now();
  await writeFile(join(directory, 'data.json'), JSON.stringify({
    schemaVersion: 1,
    agents: [],
    messages: [],
    sharedContext: '',
    documents: [],
    settings: { activeWorkspaceId: workspaceId },
    workspaces: [{
      id: workspaceId,
      name: 'Restart recovery',
      sortOrder: 0,
      gridColumns: 2,
      gridRows: 2,
      selectedAgentIds: [],
      lockedAgentIds: [],
      googleDocsTrackerEnabled: false,
      createdAt: now - 1_000,
      qaRuns: [{
        id: qaRunId,
        sourceAgentId: 'source-agent',
        prompt: 'interrupted QA',
        status: 'running',
        browserSessionId: `qa-${qaRunId}`,
        createdAt: now - 900,
        startedAt: now - 800,
      }],
      atlasRun: {
        id: atlasRunId,
        mode: 'build',
        status: 'running',
        candidateRelPath: `docs/.agent-forge-atlas-candidates/${atlasRunId}`,
        browserSessionId: `atlas-${atlasRunId}`,
        createdAt: now - 750,
        startedAt: now - 700,
        lastActivityAt: now - 650,
      },
    }],
    usageEvents: [],
  }, null, 2));
  await writeFile(join(directory, 'pids.json'), '[]');

  const serverEntry = join(import.meta.dir, 'index.ts');
  const wrapperEntry = join(directory, 'server-wrapper.mjs');
  await writeFile(wrapperEntry, [
    "import { pathToFileURL } from 'node:url';",
    'const serverModule = await import(pathToFileURL(process.argv[2]).href);',
    'await Bun.stdin.text();',
    "await serverModule.shutdown({ reason: 'end-to-end test shutdown' });",
  ].join('\n'));
  const proc = Bun.spawn([process.execPath, wrapperEntry, serverEntry], {
    cwd: directory,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BROWSER_HEADLESS: '1',
      AI_HARNESS_CLAUDE_CREDENTIALS_JSON: join(directory, 'missing-claude-credentials.json'),
      AI_HARNESS_CLAUDE_LIMITS_JSON: join(directory, 'missing-claude-limits.json'),
      AI_HARNESS_CODEX_SESSIONS_DIR: join(directory, 'missing-codex-sessions'),
      AGENT_FORGE_ARTIFACT_ROOT: join(directory, 'artifacts'),
    },
  });
  const stdout = drain(proc.stdout);
  const stderr = drain(proc.stderr);
  let exited = false;

  try {
    await waitForServer(baseUrl, proc);

    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Agent Forge');

    const forbidden = await fetch(`${baseUrl}/api/harness/instructions`, {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(forbidden.status).toBe(403);
    expect((await fetch(`${baseUrl}/not-a-route`)).status).toBe(404);

    const frames: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.addEventListener('message', event => {
      try { frames.push(JSON.parse(String(event.data))); } catch {}
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
    });

    const health = await (await fetch(`${baseUrl}/api/health`)).json() as any;
    expect(typeof health.runtime.serverSessionId).toBe('string');
    expect(health.runtime.serverSessionId.length).toBeGreaterThan(8);
    expect(['current', 'restart-required', 'unknown']).toContain(health.runtime.drift);
    expect(typeof health.runtime.bunVersion).toBe('string');
    expect(health.runtime.runningFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(health.auth.every((snapshot: any) => typeof snapshot.state === 'string' && typeof snapshot.reasonCode === 'string')).toBe(true);
    expect(JSON.stringify(health)).not.toContain('sk-ant-');

    const session = await waitForFrame(frames, frame => frame.type === 'server_session');
    expect(typeof session.serverSessionId).toBe('string');
    expect(session.serverSessionId.length).toBeGreaterThan(8);
    expect(session.serverSessionId).toBe(health.runtime.serverSessionId);

    ws.send(JSON.stringify({
      protocolVersion: 1,
      requestId: 'e2e-ping-1',
      clientSessionId: 'e2e-tab',
      sentAt: Date.now(),
      type: 'ping',
    }));
    const ack = await waitForFrame(frames, frame => frame.type === 'command_ack' && frame.requestId === 'e2e-ping-1');
    expect(ack.status).toBe('accepted');
    expect(ack.serverSessionId).toBe(session.serverSessionId);

    ws.send('{malformed');
    const invalid = await waitForFrame(frames, frame => frame.type === 'error');
    expect(invalid.message).toContain('not valid JSON');

    ws.send(JSON.stringify({ type: 'create_workspace', name: 'E2E durable workspace', cwd: directory }));
    const created = await waitForFrame(frames, frame => frame.type === 'workspace_created');
    expect(created.workspace.name).toBe('E2E durable workspace');
    expect(created.workspace.cwd).toBe(directory);
    ws.close();

    proc.stdin.write('shutdown\n');
    proc.stdin.end();
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Server shutdown timed out')), 12_000)),
    ]);
    exited = true;
    expect(exitCode).toBe(0);

    const persisted = JSON.parse(await readFile(join(directory, 'data.json'), 'utf8'));
    const recovered = persisted.workspaces.find((workspace: any) => workspace.id === workspaceId);
    expect(recovered.qaRuns[0]).toMatchObject({ status: 'failed', verdict: 'inconclusive' });
    expect(recovered.atlasRun).toMatchObject({ status: 'paused' });
    expect(persisted.workspaces.some((workspace: any) => workspace.name === 'E2E durable workspace')).toBe(true);
    expect(JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8'))).toEqual([]);
    expect(existsSync(join(directory, 'agent-forge.lock'))).toBe(false);
  } finally {
    if (!exited && proc.exitCode === null) {
      try { proc.kill('SIGKILL'); } catch {}
      await Promise.race([proc.exited, new Promise(resolve => setTimeout(resolve, 2_000))]);
    }
    const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
    if (!exited) {
      console.error('E2E server stdout:', stdoutText);
      console.error('E2E server stderr:', stderrText);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
