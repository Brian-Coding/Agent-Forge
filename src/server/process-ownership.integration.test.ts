import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessProbe } from './platform/process-probe';
import { inspectExistingServerLock, reportOccupiedPorts } from './process-startup';
import { createPersistenceService } from './services/persistence.service';
import { processExists } from './services/process-lock';
import { createOwnershipSession, recordFromProbe, terminateIfOwned } from './services/process-ownership';

const leftovers: Array<{ pid?: number; directory?: string; proc?: ReturnType<typeof Bun.spawn> }> = [];

async function spawnUnrelatedBun() {
  const directory = await mkdtemp(join(tmpdir(), 'af-unrelated-bun-'));
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', 'await Bun.sleep(60_000)'],
    cwd: directory,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  leftovers.push({ pid: proc.pid, directory, proc });
  expect(proc.pid).toBeGreaterThan(1);
  const probe = createProcessProbe();
  const deadline = Date.now() + 8_000;
  let identity = await probe.probe(proc.pid!);
  while (identity.status !== 'matched' && Date.now() < deadline) {
    await Bun.sleep(50);
    identity = await probe.probe(proc.pid!);
  }
  expect(identity.status).toBe('matched');
  expect(identity.identity?.name).toBe('bun');
  expect(identity.identity?.startTimeMs).toBeGreaterThan(0);
  return { directory, proc, identity: identity.identity! };
}

afterEach(async () => {
  for (const leftover of leftovers.splice(0)) {
    try { leftover.proc?.kill(); } catch {}
    if (leftover.pid && processExists(leftover.pid)) {
      try { process.kill(leftover.pid); } catch {}
    }
    if (leftover.proc) {
      const exited = leftover.proc.exited as Promise<number>;
      await Promise.race([exited, Bun.sleep(2_000)]);
    }
    if (leftover.directory) {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await rm(leftover.directory, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt === 7) throw error;
          await Bun.sleep(50 * (attempt + 1));
        }
      }
    }
  }
});

test('an unrelated live Bun process survives startup recovery, lock inspect, and port reporting', async () => {
  const { directory, proc, identity } = await spawnUnrelatedBun();
  const pid = proc.pid!;
  const killed: number[] = [];
  const killTree = async (candidate: number) => {
    killed.push(candidate);
    return { attempted: true, succeeded: true, exitCode: 0, timedOut: false };
  };

  const service = createPersistenceService({
    dataFile: join(directory, 'data.json'),
    pidFile: join(directory, 'pids.json'),
    ownedFile: join(directory, 'owned-processes.json'),
    probe: createProcessProbe(),
    killTree,
  });
  await writeFile(join(directory, 'pids.json'), JSON.stringify([pid]));
  expect(await service.load()).toBeNull();
  expect(killed).toEqual([]);
  expect(processExists(pid)).toBe(true);

  const requested: number[] = [];
  const staleLock = await inspectExistingServerLock({
    pid,
    startedAt: new Date(identity.startTimeMs! - 60_000).toISOString(),
  }, {
    probe: createProcessProbe(),
    isImmediateAncestor: () => false,
    requestGracefulExit(candidate) { requested.push(candidate); },
    waitForExit: async () => false,
  });
  expect(requested).toEqual([]);
  expect(staleLock.action).toBe('refuse');
  expect(processExists(pid)).toBe(true);

  const occupants = reportOccupiedPorts(
    `  TCP    127.0.0.1:3333         0.0.0.0:0              LISTENING       ${pid}`,
    3333,
    3340,
    process.pid,
  );
  expect(occupants).toEqual([pid]);
  expect(killed).toEqual([]);

  const session = createOwnershipSession();
  const outcome = await terminateIfOwned({
    record: recordFromProbe(session, 'other-owned-child', { ...identity, name: 'claude' }),
    probe: createProcessProbe(),
    killTree,
  });
  expect(outcome.killed).toBe(false);
  expect(outcome.decision.reason).toBe('pid-reused');
  expect(processExists(pid)).toBe(true);
});
