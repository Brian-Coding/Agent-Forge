import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'forge-browser-'));
const project = join(root, 'acme-notes'); await mkdir(project);
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port!; await reservation.stop(true);
const origin = `http://127.0.0.1:${port}`;
const now = Date.now();
const agents = ['Interface', 'Regression tests'].map((name, i) => ({ id: 'demo-' + i, name, cwd: project, workspaceId: 'acme', referencePaths: [], systemPrompt: '', status: 'idle', provider: i ? 'claude' : 'codex', createdAt: now }));
await writeFile(join(root, 'data.json'), JSON.stringify({ schemaVersion: 1, agents,
  messages: [
    { id: 'u0', agentId: 'demo-0', role: 'user', timestamp: now - 120000, content: 'Polish the Acme Notes search and empty state.' },
    { id: 'a0', agentId: 'demo-0', role: 'assistant', provider: 'codex', timestamp: now - 100000, content: '### Search is ready\n\nThe list filters as you type, keeps the selected note visible, and explains empty results.\n\n- Keyboard focus stays in the search field\n- Clear search restores all notes\n- Compact layouts keep the main action visible\n\n```tsx\nconst visible = notes.filter(note =>\n  note.title.toLowerCase().includes(query.toLowerCase())\n);\n```\n\n**Demo conversation** — no provider was called.' },
    { id: 'u1', agentId: 'demo-1', role: 'user', timestamp: now - 120000, content: 'Review the search behavior and add regression coverage.' },
    { id: 'a1', agentId: 'demo-1', role: 'assistant', provider: 'claude', timestamp: now - 100000, content: '### Review checklist\n\n| Scenario | Expected behavior |\n| --- | --- |\n| Partial title | Matching notes remain visible |\n| No match | Clear empty-state message |\n| Clear query | Full list returns |\n| Keyboard | Focus remains predictable |\n\nThe fixture covers fictional Acme Notes data.\n\n**Demo conversation** — illustrative results only.' },
  ], sharedContext: '', documents: [], settings: { activeWorkspaceId: 'acme' }, workspaces: [{ id: 'acme', name: 'Acme Notes', cwd: project, gridColumns: 2, gridRows: 1, sortOrder: 0, selectedAgentIds: agents.map(a => a.id), lockedAgentIds: [], createdAt: now }], usageEvents: [],
}));
const wrapper = join(root, 'server.mjs');
await writeFile(wrapper, `const m=await import(${JSON.stringify(new URL('../src/server/index.ts', import.meta.url).href)}); await Bun.stdin.text(); await m.shutdown({reason:'browser smoke'});`);
const proc = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', env: {
  ...process.env, HOST: '127.0.0.1', PORT: String(port), AI_HARNESS_CLAUDE_CREDENTIALS_JSON: join(root, 'no-credentials.json'), AI_HARNESS_CLAUDE_LIMITS_JSON: join(root, 'no-limits.json'), AI_HARNESS_CODEX_SESSIONS_DIR: join(root, 'no-sessions'), AGENT_FORGE_ARTIFACT_ROOT: join(root, 'artifacts'),
} });
try {
  for(let i=0;i<150;i++) { try { if ((await fetch(origin + '/api/harness/instructions')).ok) break; } catch {} await Bun.sleep(100); }
  const check = Bun.spawn(['node', resolve(import.meta.dir, 'browser-check.mjs'), origin, process.env.FORGE_CAPTURE_PREVIEW === '1' ? 'capture' : 'check'], { stdout: 'inherit', stderr: 'inherit' });
  assert.equal(await check.exited, 0, 'Browser acceptance checks failed');
} finally {
  proc.stdin.end();
  const timer=setTimeout(()=>proc.kill('SIGKILL'),5000); await proc.exited; clearTimeout(timer);
  await rm(root,{recursive:true,force:true});
}
