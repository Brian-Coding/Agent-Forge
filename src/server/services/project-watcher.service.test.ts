import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FSWatcher } from 'fs';
import { agentService } from './agent.service';
import { browserService } from './browser.service';
import {
  classifyWatchedPath,
  createProjectWatcherHub,
  isPathInsideRoot,
  isRebuildTriggerPath,
  projectWatcherHub,
  shouldIgnoreWatchedPath,
} from './project-watcher.service';
import { persistenceService } from './persistence.service';

class FakeWatcher extends EventEmitter {
  closed = false;
  constructor(
    readonly path: string,
    readonly callback: (eventType: string, filename: string) => void,
  ) {
    super();
  }
  close() { this.closed = true; }
  emitChange(filename: string) { this.callback('change', filename); }
}

function createFakeWatch() {
  const watchers: FakeWatcher[] = [];
  const watch = ((path: string, optsOrCb: unknown, maybeCb?: unknown) => {
    const callback = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (eventType: string, filename: string) => void;
    const watcher = new FakeWatcher(path, callback);
    watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  }) as typeof import('fs').watch;
  return { watch, watchers };
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!predicate(value) && Date.now() < deadline) {
    await Bun.sleep(10);
    value = read();
  }
  return value;
}

const hubs: Array<ReturnType<typeof createProjectWatcherHub>> = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

test('ignore policy keeps generated, lock, and artifact paths out of source batches', () => {
  expect(classifyWatchedPath('src/app.ts')).toBe('source');
  expect(shouldIgnoreWatchedPath('node_modules/left-pad/index.js')).toBe(true);
  expect(shouldIgnoreWatchedPath('.plans/active.md')).toBe(true);
  expect(shouldIgnoreWatchedPath('dist/bundle.js')).toBe(true);
  expect(shouldIgnoreWatchedPath('owned-processes.json')).toBe(true);
  expect(classifyWatchedPath('screenshots/qa.png')).toBe('artifact');
  expect(isRebuildTriggerPath('src/app.ts')).toBe(true);
  expect(isRebuildTriggerPath('.plans/active.md')).toBe(false);
  expect(isRebuildTriggerPath('screenshots/qa.png')).toBe(false);
});

test('three agents sharing one project create one source watcher and one plan watcher', () => {
  const { watch, watchers } = createFakeWatch();
  const hub = createProjectWatcherHub({
    watch,
    realpath: path => resolve(path),
    exists: () => true,
    debounceSourceMs: 15,
    debouncePlanMs: 15,
    platform: 'win32',
  });
  hubs.push(hub);
  const root = 'C:\\shared\\project';
  hub.subscribeSource('a', root, () => {});
  hub.subscribeSource('b', root, () => {});
  hub.subscribeSource('c', 'C:/shared/project', () => {});
  hub.subscribePlans('a', root, () => {});
  hub.subscribePlans('b', 'c:\\shared\\project', () => {});
  hub.subscribePlans('c', root, () => {});
  expect(hub.getMetrics()).toEqual({
    sourceWatchers: 1,
    planWatchers: 1,
    sourceSubscribers: 3,
    planSubscribers: 3,
    degradedRoots: 0,
  });
  expect(watchers).toHaveLength(2);
});

test('case and slash aliases collapse to one Windows watcher', () => {
  const { watch, watchers } = createFakeWatch();
  const hub = createProjectWatcherHub({
    watch,
    realpath: () => 'C:\\Repo\\App',
    exists: () => true,
    platform: 'win32',
  });
  hubs.push(hub);
  hub.subscribeSource('one', 'C:\\repo\\app', () => {});
  hub.subscribeSource('two', 'C:/REPO/APP', () => {});
  expect(watchers).toHaveLength(1);
  expect(hub.getMetrics().sourceWatchers).toBe(1);
});

test('a junction or symlink escape is rejected before fanout', async () => {
  const { watch, watchers } = createFakeWatch();
  const hub = createProjectWatcherHub({
    watch,
    realpath: path => path.toLowerCase().includes('escape') ? 'C:\\outside\\secret.txt' : path,
    exists: () => true,
    debounceSourceMs: 10,
    platform: 'win32',
  });
  hubs.push(hub);
  const received: string[][] = [];
  hub.subscribeSource('agent', 'C:\\safe\\project', event => { received.push(event.changedRelativePaths); });
  expect(isPathInsideRoot('C:\\safe\\project', 'escape\\secret.txt', {
    realpath: path => path.toLowerCase().includes('escape') ? 'C:\\outside\\secret.txt' : path,
  })).toBe(false);
  watchers[0]!.emitChange('escape\\secret.txt');
  watchers[0]!.emitChange('src\\app.ts');
  const batches = await waitFor(() => received, value => value.length > 0);
  expect(batches).toEqual([['src/app.ts']]);
});

test('the last subscriber close tears down the physical watcher', () => {
  const { watch, watchers } = createFakeWatch();
  const hub = createProjectWatcherHub({
    watch,
    realpath: path => path,
    exists: () => true,
    platform: 'linux',
  });
  hubs.push(hub);
  hub.subscribeSource('a', '/tmp/project', () => {});
  hub.subscribeSource('b', '/tmp/project', () => {});
  hub.unsubscribeSource('a');
  expect(watchers[0]?.closed).toBe(false);
  hub.unsubscribeSource('b');
  expect(watchers[0]?.closed).toBe(true);
  expect(hub.getMetrics().sourceWatchers).toBe(0);
});

test('stale-generation events from a replaced watcher are ignored', async () => {
  const { watch, watchers } = createFakeWatch();
  const hub = createProjectWatcherHub({
    watch,
    realpath: path => path,
    exists: () => true,
    debounceSourceMs: 10,
    recoverBackoffMs: 10,
    platform: 'linux',
  });
  hubs.push(hub);
  const received: string[] = [];
  hub.subscribeSource('a', '/tmp/project', event => { received.push(...event.changedRelativePaths); });
  const first = watchers[0]!;
  first.emit('error', new Error('watcher died'));
  await waitFor(() => watchers.length, value => value === 2);
  first.emitChange('old.ts');
  watchers[1]!.emitChange('new.ts');
  const paths = await waitFor(() => received, value => value.includes('new.ts'));
  expect(paths).toEqual(['new.ts']);
});

test('duplicate bursts collapse and overflow is bounded', async () => {
  const { watch, watchers } = createFakeWatch();
  const hub = createProjectWatcherHub({
    watch,
    realpath: path => path,
    exists: () => true,
    debounceSourceMs: 10,
    maxBatch: 2,
    platform: 'linux',
  });
  hubs.push(hub);
  const events: Array<{ paths: string[]; overflowed: boolean }> = [];
  hub.subscribeSource('a', '/tmp/project', event => {
    events.push({ paths: event.changedRelativePaths, overflowed: event.overflowed });
  });
  watchers[0]!.emitChange('a.ts');
  watchers[0]!.emitChange('a.ts');
  watchers[0]!.emitChange('b.ts');
  watchers[0]!.emitChange('c.ts');
  const batch = await waitFor(() => events, value => value.length === 1);
  expect(batch[0]?.paths).toEqual(['a.ts', 'b.ts']);
  expect(batch[0]?.overflowed).toBe(true);
});

test('ignored output directories never reach source subscribers', async () => {
  const { watch, watchers } = createFakeWatch();
  const hub = createProjectWatcherHub({
    watch,
    realpath: path => path,
    exists: () => true,
    debounceSourceMs: 10,
    platform: 'linux',
  });
  hubs.push(hub);
  const received: string[][] = [];
  hub.subscribeSource('a', '/tmp/project', event => { received.push(event.changedRelativePaths); });
  watchers[0]!.emitChange('dist/bundle.js');
  watchers[0]!.emitChange('.plans/active.md');
  await Bun.sleep(40);
  expect(received).toEqual([]);
});

test('a throwing watcher constructor degrades without leaking a handle', () => {
  const hub = createProjectWatcherHub({
    watch: () => { throw new Error('watch unavailable'); },
    realpath: path => path,
    exists: () => true,
    platform: 'linux',
  });
  hubs.push(hub);
  const result = hub.subscribeSource('a', '/tmp/project', () => {});
  expect(result.degraded).toBe(true);
  expect(hub.getMetrics()).toMatchObject({ sourceWatchers: 0, degradedRoots: 1 });
});

test('a slow or throwing subscriber does not block sibling agents', async () => {
  const { watch, watchers } = createFakeWatch();
  const hub = createProjectWatcherHub({
    watch,
    realpath: path => path,
    exists: () => true,
    debounceSourceMs: 10,
    platform: 'linux',
  });
  hubs.push(hub);
  const received: string[] = [];
  hub.subscribeSource('slow', '/tmp/project', () => { throw new Error('subscriber exploded'); });
  hub.subscribeSource('ok', '/tmp/project', event => { received.push(...event.changedRelativePaths); });
  watchers[0]!.emitChange('ok.ts');
  const paths = await waitFor(() => received, value => value.length > 0);
  expect(paths).toEqual(['ok.ts']);
});

test('plan file events fan out to every subscriber of that root', async () => {
  const { watch, watchers } = createFakeWatch();
  const hub = createProjectWatcherHub({
    watch,
    realpath: path => path,
    exists: () => true,
    debouncePlanMs: 10,
    platform: 'linux',
  });
  hubs.push(hub);
  const received: string[] = [];
  hub.subscribePlans('a', '/tmp/project', filePath => { received.push(`a:${filePath}`); });
  hub.subscribePlans('b', '/tmp/project', filePath => { received.push(`b:${filePath}`); });
  const planWatcher = watchers.find(watcher => watcher.path.endsWith('.plans'));
  planWatcher!.emitChange('active.md');
  const files = await waitFor(() => received, value => value.length === 2);
  const planPath = join(resolve('/tmp/project'), '.plans', 'active.md');
  expect(files.sort()).toEqual([`a:${planPath}`, `b:${planPath}`]);
});

test('five agents across two real roots share two source watchers and two plan watchers', async () => {
  const first = await mkdtemp(join(tmpdir(), 'af-watch-a-'));
  const second = await mkdtemp(join(tmpdir(), 'af-watch-b-'));
  await mkdir(join(first, '.plans'));
  await mkdir(join(second, '.plans'));
  await writeFile(join(first, '.plans', 'README.md'), '# one\n');
  await writeFile(join(second, '.plans', 'README.md'), '# two\n');
  const previous = {
    sourceWatchers: projectWatcherHub.getMetrics().sourceWatchers,
    planWatchers: projectWatcherHub.getMetrics().planWatchers,
  };
  const ids = ['a1', 'a2', 'a3', 'b1', 'b2'];
  try {
    projectWatcherHub.subscribeSource('a1', first, () => {});
    projectWatcherHub.subscribeSource('a2', first, () => {});
    projectWatcherHub.subscribeSource('a3', first, () => {});
    projectWatcherHub.subscribeSource('b1', second, () => {});
    projectWatcherHub.subscribeSource('b2', second, () => {});
    projectWatcherHub.subscribePlans('a1', first, () => {});
    projectWatcherHub.subscribePlans('a2', first, () => {});
    projectWatcherHub.subscribePlans('a3', first, () => {});
    projectWatcherHub.subscribePlans('b1', second, () => {});
    projectWatcherHub.subscribePlans('b2', second, () => {});
    const metrics = projectWatcherHub.getMetrics();
    expect(metrics.sourceWatchers).toBe(previous.sourceWatchers + 2);
    expect(metrics.planWatchers).toBe(previous.planWatchers + 2);
  } finally {
    for (const id of ids) projectWatcherHub.unsubscribeAll(id);
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('a real source change notifies the browser worker readiness path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'af-watch-ready-'));
  const id = 'watch-ready-agent';
  const notified: string[] = [];
  const originalNotify = browserService.notifyFileChanged;
  const originalSave = persistenceService.save;
  const originalSaveNow = persistenceService.saveNow;
  browserService.notifyFileChanged = async workspaceId => { notified.push(workspaceId); };
  persistenceService.save = () => {};
  persistenceService.saveNow = async () => {};
  try {
    agentService.load({
      agents: [{
        id,
        name: 'Watcher',
        cwd: directory,
        referencePaths: [],
        systemPrompt: '',
        status: 'idle',
        createdAt: Date.now(),
        workspaceId: 'workspace-ready',
        provider: 'codex',
      }],
      messages: [],
      sharedContext: '',
    });
    await writeFile(join(directory, 'ready-signal.ts'), 'export {}\n');
    const seen = await waitFor(() => notified, value => value.includes('workspace-ready'), 3_000);
    expect(seen).toContain('workspace-ready');
  } finally {
    browserService.notifyFileChanged = originalNotify;
    persistenceService.save = originalSave;
    persistenceService.saveNow = originalSaveNow;
    if (agentService.getAgent(id)) await agentService.removeAgent(id).catch(() => false);
    await rm(directory, { recursive: true, force: true });
  }
});
