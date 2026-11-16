import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeSpawn, killProcessTree } from './utils';

for (const parentExitsFirst of [false, true]) test.skipIf(process.platform === 'win32')(`owned group removes real child and grandchild (parent already exited: ${parentExitsFirst})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-process-test-'));
  const fixture = join(root, 'tree.mjs');
  await writeFile(fixture, `
    import { writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const depth = Number(process.argv[2]);
    writeFileSync(process.argv[3] + '/' + depth + '.pid', String(process.pid));
    if (depth < 2) spawn(process.execPath, [process.argv[1], String(depth + 1), process.argv[3]], { stdio: 'ignore' });
    process.on('SIGINT', () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  const proc = safeSpawn([process.execPath, fixture, '0', root], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const pids: number[] = [proc.pid];
  try {
    for (let i = 0; i < 100; i++) {
      try { await readFile(join(root, '2.pid')); break; } catch { await Bun.sleep(20); }
    }
    pids.push(Number(await readFile(join(root, '1.pid'), 'utf8')), Number(await readFile(join(root, '2.pid'), 'utf8')));
    if (parentExitsFirst) { proc.kill('SIGINT'); await proc.exited; }
    const result = await killProcessTree(proc);
    expect(result.rootExited).toBe(true);
    expect(result.treeKill.succeeded).toBe(true);
    for (const pid of pids) {
      const probe = Bun.spawn(['ps', '-p', String(pid), '-o', 'stat='], { stdout: 'pipe' });
      const state = (await new Response(probe.stdout).text()).trim();
      await probe.exited;
      expect(state === '' || state.startsWith('Z')).toBe(true);
    }
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await proc.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
