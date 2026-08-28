import { existsSync, realpathSync, watch, type FSWatcher } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

export type WatchedPathClass = 'source' | 'ignored' | 'artifact';

export interface ProjectFilesChanged {
  rootId: string;
  generation: number;
  changedRelativePaths: string[];
  overflowed: boolean;
  observedAt: number;
  kind: 'source' | 'plan';
}

export interface ProjectWatcherMetrics {
  sourceWatchers: number;
  planWatchers: number;
  sourceSubscribers: number;
  planSubscribers: number;
  degradedRoots: number;
}

export interface ProjectWatcherHub {
  subscribeSource(agentId: string, cwd: string, onBatch: (event: ProjectFilesChanged) => void): SubscribeResult;
  subscribePlans(agentId: string, cwd: string, onFile: (filePath: string) => void): SubscribeResult;
  unsubscribeSource(agentId: string): void;
  unsubscribePlans(agentId: string): void;
  unsubscribeAll(agentId: string): void;
  getMetrics(): ProjectWatcherMetrics;
  close(): void;
}

export interface SubscribeResult {
  canonicalRoot: string | null;
  degraded: boolean;
  reason?: string;
}

export interface ProjectWatcherHubOptions {
  watch?: typeof watch;
  realpath?: (path: string) => string;
  exists?: (path: string) => boolean;
  debounceSourceMs?: number;
  debouncePlanMs?: number;
  maxBatch?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
  recoverBackoffMs?: number;
  maxRecoveries?: number;
}

const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'logs',
  'tmp',
  'temp',
]);

const IGNORED_FILES = new Set([
  'data.json',
  'pids.json',
  'owned-processes.json',
  'agent-forge.lock',
  'data.json.tmp',
  'pids.json.tmp',
  'owned-processes.json.tmp',
]);

const ARTIFACT_SEGMENTS = new Set(['screenshots', 'chat-images']);

export function normalizeWatchedRelative(filename: string): string {
  return filename.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function classifyWatchedPath(relativePath: string): WatchedPathClass {
  const normalized = normalizeWatchedRelative(relativePath);
  if (!normalized) return 'ignored';
  const parts = normalized.split('/');
  const base = parts[parts.length - 1]!;
  if (IGNORED_FILES.has(base)) return 'ignored';
  if (parts[0]!.startsWith('.')) return 'ignored';
  if (parts.some(part => IGNORED_SEGMENTS.has(part))) return 'ignored';
  if (parts.some(part => part.startsWith('.agent-forge') || ARTIFACT_SEGMENTS.has(part))) return 'artifact';
  return 'source';
}

export function shouldIgnoreWatchedPath(relativePath: string): boolean {
  return classifyWatchedPath(relativePath) !== 'source';
}

export function isRebuildTriggerPath(relativePath: string): boolean {
  return classifyWatchedPath(relativePath) === 'source';
}

export function canonicalizeProjectRoot(
  cwd: string,
  options: { realpath?: (path: string) => string; platform?: NodeJS.Platform } = {},
): SubscribeResult {
  const requested = cwd.trim();
  if (!requested) return { canonicalRoot: null, degraded: true, reason: 'empty' };
  const resolved = resolve(requested);
  try {
    const real = options.realpath?.(resolved) ?? realpathSync(resolved);
    const key = normalizeRootKey(real, options.platform ?? process.platform);
    return { canonicalRoot: key, degraded: false };
  } catch {
    return { canonicalRoot: null, degraded: true, reason: 'unresolved' };
  }
}

export function normalizeRootKey(pathValue: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = resolve(pathValue);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathInsideRoot(
  root: string,
  relativePath: string,
  options: { realpath?: (path: string) => string } = {},
): boolean {
  const normalized = normalizeWatchedRelative(relativePath);
  if (!normalized || isAbsolute(normalized)) return false;
  const candidate = resolve(root, normalized);
  const lexical = relative(root, candidate);
  if (!lexical || lexical.startsWith('..') || isAbsolute(lexical)) return false;
  try {
    const realRoot = options.realpath?.(root) ?? realpathSync(root);
    const realCandidate = options.realpath?.(candidate) ?? realpathSync(candidate);
    const escaped = relative(realRoot, realCandidate);
    if (!escaped || escaped.startsWith('..') || isAbsolute(escaped)) return false;
  } catch {
    // Deleted or unreadable paths still pass on lexical containment.
  }
  return true;
}

interface SourceSubscriber {
  onBatch(event: ProjectFilesChanged): void;
}

interface PlanSubscriber {
  onFile(filePath: string): void;
}

interface WatchEntry {
  canonicalRoot: string;
  generation: number;
  sourceWatcher: FSWatcher | null;
  planWatcher: FSWatcher | null;
  sourceSubscribers: Map<string, SourceSubscriber>;
  planSubscribers: Map<string, PlanSubscriber>;
  pendingSource: Set<string>;
  pendingPlans: Set<string>;
  sourceTimer: ReturnType<typeof setTimeout> | null;
  planTimer: ReturnType<typeof setTimeout> | null;
  sourceOverflowed: boolean;
  recoverTimer: ReturnType<typeof setTimeout> | null;
  recoveries: number;
  degraded: boolean;
  state: 'starting' | 'ready' | 'recovering' | 'closed';
}

export function createProjectWatcherHub(options: ProjectWatcherHubOptions = {}): ProjectWatcherHub {
  const watchFn = options.watch ?? watch;
  const realpathFn = options.realpath ?? realpathSync;
  const existsFn = options.exists ?? existsSync;
  const debounceSourceMs = options.debounceSourceMs ?? 1_000;
  const debouncePlanMs = options.debouncePlanMs ?? 300;
  const maxBatch = options.maxBatch ?? 256;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const recoverBackoffMs = options.recoverBackoffMs ?? 50;
  const maxRecoveries = options.maxRecoveries ?? 5;

  const entries = new Map<string, WatchEntry>();
  const sourceMembership = new Map<string, string>();
  const planMembership = new Map<string, string>();

  const getOrCreate = (canonicalRoot: string): WatchEntry => {
    const existing = entries.get(canonicalRoot);
    if (existing && existing.state !== 'closed') return existing;
    const created: WatchEntry = {
      canonicalRoot,
      generation: existing ? existing.generation + 1 : 1,
      sourceWatcher: null,
      planWatcher: null,
      sourceSubscribers: new Map(),
      planSubscribers: new Map(),
      pendingSource: new Set(),
      pendingPlans: new Set(),
      sourceTimer: null,
      planTimer: null,
      sourceOverflowed: false,
      recoverTimer: null,
      recoveries: 0,
      degraded: false,
      state: 'starting',
    };
    entries.set(canonicalRoot, created);
    return created;
  };

  const flushSource = (entry: WatchEntry) => {
    if (entry.sourceTimer) {
      clearTimeout(entry.sourceTimer);
      entry.sourceTimer = null;
    }
    if (entry.pendingSource.size === 0 && !entry.sourceOverflowed) return;
    const event: ProjectFilesChanged = {
      rootId: entry.canonicalRoot,
      generation: entry.generation,
      changedRelativePaths: [...entry.pendingSource],
      overflowed: entry.sourceOverflowed,
      observedAt: now(),
      kind: 'source',
    };
    entry.pendingSource.clear();
    entry.sourceOverflowed = false;
    for (const subscriber of [...entry.sourceSubscribers.values()]) {
      queueMicrotask(() => {
        try { subscriber.onBatch(event); } catch (error) {
          console.error('[project-watcher] source subscriber failed:', error);
        }
      });
    }
  };

  const flushPlans = (entry: WatchEntry) => {
    if (entry.planTimer) {
      clearTimeout(entry.planTimer);
      entry.planTimer = null;
    }
    const files = [...entry.pendingPlans];
    entry.pendingPlans.clear();
    for (const filePath of files) {
      for (const subscriber of [...entry.planSubscribers.values()]) {
        queueMicrotask(() => {
          try { subscriber.onFile(filePath); } catch (error) {
            console.error('[project-watcher] plan subscriber failed:', error);
          }
        });
      }
    }
  };

  const closeWatcher = (watcher: FSWatcher | null) => {
    if (!watcher) return;
    try { watcher.close(); } catch {}
  };

  const abandonEntry = (entry: WatchEntry) => {
    entry.generation += 1;
    entry.state = 'closed';
    if (entry.sourceTimer) clearTimeout(entry.sourceTimer);
    if (entry.planTimer) clearTimeout(entry.planTimer);
    if (entry.recoverTimer) clearTimeout(entry.recoverTimer);
    entry.sourceTimer = null;
    entry.planTimer = null;
    entry.recoverTimer = null;
    closeWatcher(entry.sourceWatcher);
    closeWatcher(entry.planWatcher);
    entry.sourceWatcher = null;
    entry.planWatcher = null;
    entries.delete(entry.canonicalRoot);
  };

  const maybeClose = (entry: WatchEntry) => {
    if (entry.sourceSubscribers.size === 0 && entry.planSubscribers.size === 0) {
      abandonEntry(entry);
    }
  };

  const attachSourceWatcher = (entry: WatchEntry) => {
    if (entry.sourceWatcher || entry.sourceSubscribers.size === 0) return;
    const generation = entry.generation;
    try {
      const watcher = watchFn(entry.canonicalRoot, { recursive: true }, (_eventType, filename) => {
        if (entry.generation !== generation || typeof filename !== 'string' || !filename) return;
        if (!isPathInsideRoot(entry.canonicalRoot, filename, { realpath: realpathFn })) return;
        if (shouldIgnoreWatchedPath(filename)) return;
        const relativePath = normalizeWatchedRelative(filename);
        if (entry.pendingSource.size >= maxBatch) {
          entry.sourceOverflowed = true;
        } else {
          entry.pendingSource.add(relativePath);
        }
        if (entry.sourceTimer) clearTimeout(entry.sourceTimer);
        entry.sourceTimer = setTimeout(() => flushSource(entry), debounceSourceMs);
      });
      watcher.on?.('error', () => {
        if (entry.generation !== generation) return;
        scheduleRecover(entry, 'source');
      });
      entry.sourceWatcher = watcher;
      entry.state = 'ready';
      entry.degraded = false;
    } catch (error) {
      entry.degraded = true;
      console.error(`[project-watcher] source watch failed for ${entry.canonicalRoot}:`, error);
    }
  };

  const attachPlanWatcher = (entry: WatchEntry) => {
    if (entry.planWatcher || entry.planSubscribers.size === 0) return;
    const plansDir = join(entry.canonicalRoot, '.plans');
    if (!existsFn(plansDir)) return;
    const generation = entry.generation;
    try {
      const watcher = watchFn(plansDir, (_eventType, filename) => {
        if (entry.generation !== generation || typeof filename !== 'string' || !filename) return;
        if (!filename.endsWith('.md')) return;
        const filePath = join(plansDir, filename);
        if (!isPathInsideRoot(plansDir, filename, { realpath: realpathFn })) return;
        entry.pendingPlans.add(filePath);
        if (entry.planTimer) clearTimeout(entry.planTimer);
        entry.planTimer = setTimeout(() => flushPlans(entry), debouncePlanMs);
      });
      watcher.on?.('error', () => {
        if (entry.generation !== generation) return;
        scheduleRecover(entry, 'plan');
      });
      entry.planWatcher = watcher;
      entry.state = 'ready';
    } catch (error) {
      entry.degraded = true;
      console.error(`[project-watcher] plan watch failed for ${plansDir}:`, error);
    }
  };

  const scheduleRecover = (entry: WatchEntry, kind: 'source' | 'plan') => {
    if (entry.recoveries >= maxRecoveries) {
      entry.degraded = true;
      entry.state = 'closed';
      return;
    }
    entry.state = 'recovering';
    entry.generation += 1;
    if (kind === 'source') {
      closeWatcher(entry.sourceWatcher);
      entry.sourceWatcher = null;
    } else {
      closeWatcher(entry.planWatcher);
      entry.planWatcher = null;
    }
    if (entry.recoverTimer) clearTimeout(entry.recoverTimer);
    const delay = recoverBackoffMs * (2 ** entry.recoveries);
    entry.recoveries += 1;
    entry.recoverTimer = setTimeout(() => {
      entry.recoverTimer = null;
      if (kind === 'source') attachSourceWatcher(entry);
      else attachPlanWatcher(entry);
    }, delay);
  };

  const moveSourceMembership = (agentId: string, canonicalRoot: string) => {
    const previous = sourceMembership.get(agentId);
    if (previous && previous !== canonicalRoot) {
      const prior = entries.get(previous);
      prior?.sourceSubscribers.delete(agentId);
      if (prior) maybeClose(prior);
    }
    sourceMembership.set(agentId, canonicalRoot);
  };

  const movePlanMembership = (agentId: string, canonicalRoot: string) => {
    const previous = planMembership.get(agentId);
    if (previous && previous !== canonicalRoot) {
      const prior = entries.get(previous);
      prior?.planSubscribers.delete(agentId);
      if (prior) maybeClose(prior);
    }
    planMembership.set(agentId, canonicalRoot);
  };

  return {
    subscribeSource(agentId, cwd, onBatch) {
      const resolved = canonicalizeProjectRoot(cwd, { realpath: realpathFn, platform });
      if (!resolved.canonicalRoot) return resolved;
      if (!existsFn(resolved.canonicalRoot)) {
        return { canonicalRoot: null, degraded: true, reason: 'missing' };
      }
      const entry = getOrCreate(resolved.canonicalRoot);
      moveSourceMembership(agentId, entry.canonicalRoot);
      entry.sourceSubscribers.set(agentId, { onBatch });
      attachSourceWatcher(entry);
      return { canonicalRoot: entry.canonicalRoot, degraded: entry.degraded };
    },

    subscribePlans(agentId, cwd, onFile) {
      const resolved = canonicalizeProjectRoot(cwd, { realpath: realpathFn, platform });
      if (!resolved.canonicalRoot) return resolved;
      if (!existsFn(join(resolved.canonicalRoot, '.plans'))) {
        return { canonicalRoot: resolved.canonicalRoot, degraded: false, reason: 'no-plans' };
      }
      const entry = getOrCreate(resolved.canonicalRoot);
      movePlanMembership(agentId, entry.canonicalRoot);
      entry.planSubscribers.set(agentId, { onFile });
      attachPlanWatcher(entry);
      return { canonicalRoot: entry.canonicalRoot, degraded: entry.degraded };
    },

    unsubscribeSource(agentId) {
      const root = sourceMembership.get(agentId);
      sourceMembership.delete(agentId);
      if (!root) return;
      const entry = entries.get(root);
      if (!entry) return;
      entry.sourceSubscribers.delete(agentId);
      if (entry.sourceSubscribers.size === 0) {
        if (entry.sourceTimer) clearTimeout(entry.sourceTimer);
        entry.sourceTimer = null;
        closeWatcher(entry.sourceWatcher);
        entry.sourceWatcher = null;
      }
      maybeClose(entry);
    },

    unsubscribePlans(agentId) {
      const root = planMembership.get(agentId);
      planMembership.delete(agentId);
      if (!root) return;
      const entry = entries.get(root);
      if (!entry) return;
      entry.planSubscribers.delete(agentId);
      if (entry.planSubscribers.size === 0) {
        if (entry.planTimer) clearTimeout(entry.planTimer);
        entry.planTimer = null;
        closeWatcher(entry.planWatcher);
        entry.planWatcher = null;
      }
      maybeClose(entry);
    },

    unsubscribeAll(agentId) {
      this.unsubscribeSource(agentId);
      this.unsubscribePlans(agentId);
    },

    getMetrics() {
      let sourceWatchers = 0;
      let planWatchers = 0;
      let sourceSubscribers = 0;
      let planSubscribers = 0;
      let degradedRoots = 0;
      for (const entry of entries.values()) {
        if (entry.sourceWatcher) sourceWatchers += 1;
        if (entry.planWatcher) planWatchers += 1;
        sourceSubscribers += entry.sourceSubscribers.size;
        planSubscribers += entry.planSubscribers.size;
        if (entry.degraded) degradedRoots += 1;
      }
      return { sourceWatchers, planWatchers, sourceSubscribers, planSubscribers, degradedRoots };
    },

    close() {
      for (const entry of [...entries.values()]) abandonEntry(entry);
      sourceMembership.clear();
      planMembership.clear();
    },
  };
}

const existingHub = (globalThis as any).__projectWatcherHub as ProjectWatcherHub | undefined;
export const projectWatcherHub: ProjectWatcherHub = existingHub ?? createProjectWatcherHub();
(globalThis as any).__projectWatcherHub = projectWatcherHub;
