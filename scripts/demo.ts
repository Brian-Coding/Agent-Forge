// Launch the actual workbench against disposable fictional state. This entry
// never launches a provider CLI; demo-server registers scripted adapters.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'forge-demo-'));
const project = join(root, 'acme-notes');
await mkdir(project);
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port!; await reservation.stop(true);
let previewPort = 5187;
for (; previewPort < 5250; previewPort++) {
  try {
    const previewReservation = Bun.serve({ hostname: '127.0.0.1', port: previewPort, fetch: () => new Response('') });
    await previewReservation.stop(true); break;
  } catch { /* Try the next free development port; never stop an existing listener. */ }
}
if (previewPort === 5250) throw new Error('No free demo preview port in 5187–5249');
const now = Date.now();
const agents = ['Interface · scripted', 'Verification · scripted'].map((name, i) => ({ id: 'demo-' + i, name, cwd: project,
  workspaceId: 'acme', referencePaths: [], systemPrompt: '', status: 'idle', provider: i ? 'claude' : 'codex', createdAt: now }));
await writeFile(join(project, 'notes.cjs'), "exports.search = (notes, query) => notes.filter(note => note.toLowerCase().includes(query.toLowerCase()));\n");
await writeFile(join(project, 'smoke.test.cjs'), "const {test}=require('node:test'); const assert=require('node:assert/strict'); const {search}=require('./notes.cjs');\ntest('partial title matches',()=>assert.deepEqual(search(['Kickoff','Groceries'],'kick'),['Kickoff']));\ntest('empty state is explicit',()=>assert.deepEqual(search(['Kickoff'],'missing'),[]));\ntest('clear search restores notes',()=>assert.deepEqual(search(['Kickoff'],''),['Kickoff']));\n");
await writeFile(join(project, 'preview.cjs'), `require('node:http').createServer((req,res)=>res.end('<h1>Acme Notes</h1><p>Fictional preview for the scripted Forge demo.</p>')).listen(${previewPort},'127.0.0.1',()=>console.log('Acme Notes preview: http://127.0.0.1:${previewPort}'));\n`);
await writeFile(join(root, 'data.json'), JSON.stringify({ schemaVersion: 1, agents, messages: [], sharedContext: '', documents: [],
  settings: { activeWorkspaceId: 'acme' }, workspaces: [{ id: 'acme', name: 'Acme Notes · scripted demo', cwd: project,
  gridColumns: 2, gridRows: 1, sortOrder: 0, selectedAgentIds: agents.map(a => a.id), lockedAgentIds: [], createdAt: now,
  testUrl: `http://127.0.0.1:${previewPort}` }], usageEvents: [] }));
const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, 'demo/server.ts')], { cwd: root, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
  // No provider credentials are inherited. Background account/limit discovery
  // is disabled in the demo-only entry point below.
  env: { PATH: process.env.PATH ?? `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, FORGE_DEMO_PREVIEW_PORT: String(previewPort), HOST: '127.0.0.1', PORT: String(port),
    AGENT_FORGE_MACHINE_ID: 'fictional-demo', AGENT_FORGE_ARTIFACT_ROOT: join(root, 'artifacts'),
    AGENT_FORGE_USAGE_SYNC_DIR: join(root, 'usage'), AI_HARNESS_CLAUDE_CREDENTIALS_JSON: join(root, 'no-credentials'),
    AI_HARNESS_CLAUDE_LIMITS_JSON: join(root, 'no-limits'), AI_HARNESS_CODEX_SESSIONS_DIR: join(root, 'no-sessions') } });
const origin = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(origin + '/api/session')).ok) { ready = true; break; } } catch {} await Bun.sleep(100); }
  if (!ready) throw new Error('Demo server did not become ready');
  console.log(`Scripted demo (no model calls): ${origin}\nSend a message in either pane. Tests and preview run as real terminal processes. Ctrl+C stops and removes disposable state.`);
  if (process.argv.includes('--media') || process.argv.includes('--check')) {
    const child = Bun.spawn(['node', resolve(import.meta.dir, 'demo/record.mjs'), origin, process.argv.includes('--media') ? 'media' : 'check', String(previewPort)], { stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited !== 0) throw new Error('Demo browser flow failed');
  } else {
    await new Promise<void>(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
  }
} finally {
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
  await proc.exited; clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
}
