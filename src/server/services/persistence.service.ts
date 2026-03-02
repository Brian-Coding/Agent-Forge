import type { PersistedData } from '../../shared/protocol';
import { treeKill } from '../utils';

const DATA_FILE = './data.json';
const PID_FILE = './pids.json';

// Serialized persist with debounce
let persistChain: Promise<void> = Promise.resolve();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDirty = false;

// Serialized PID save with debounce
let pidChain: Promise<void> = Promise.resolve();
let pidTimer: ReturnType<typeof setTimeout> | null = null;
let pidDirty = false;

// Active child PIDs for orphan cleanup
const activePids: Set<number> = (globalThis as any).__activePids ??= new Set<number>();

// Collector function — set by init() to gather state from all services
let buildPersistedData: (() => PersistedData) | null = null;

export const persistenceService = {
  /** Register the function that collects persisted state from all services */
  setBuildPersistedData(fn: () => PersistedData) {
    buildPersistedData = fn;
  },

  // --- Data persistence ---

  async _writeData(): Promise<void> {
    if (!buildPersistedData) return;
    const tmpFile = DATA_FILE + '.tmp';
    try {
      const data = buildPersistedData();
      await Bun.write(tmpFile, JSON.stringify(data, null, 2));
      const { renameSync } = await import('fs');
      renameSync(tmpFile, DATA_FILE);
    } catch (e) {
      console.error('Failed to persist data:', e);
    }
  },

  /** Debounced save — batches rapid mutations into a single write */
  save(): void {
    persistDirty = true;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!persistDirty) return;
      persistDirty = false;
      persistChain = persistChain
        .then(() => persistenceService._writeData())
        .catch(e => console.error('Persist error:', e));
    }, 200);
  },

  /** Immediate save — flushes pending writes (for shutdown, critical mutations) */
  async saveNow(): Promise<void> {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    persistDirty = false;
    persistChain = persistChain
      .then(() => persistenceService._writeData())
      .catch(e => console.error('Persist error:', e));
    return persistChain;
  },

  // --- PID tracking ---

  async _writePids(): Promise<void> {
    const tmpFile = PID_FILE + '.tmp';
    try {
      await Bun.write(tmpFile, JSON.stringify([...activePids]));
      const { renameSync } = await import('fs');
      renameSync(tmpFile, PID_FILE);
    } catch (e) {
      console.error('Failed to save PIDs:', e);
    }
  },

  scheduleSavePids(): void {
    pidDirty = true;
    if (pidTimer) return;
    pidTimer = setTimeout(() => {
      pidTimer = null;
      if (!pidDirty) return;
      pidDirty = false;
      pidChain = pidChain
        .then(() => persistenceService._writePids())
        .catch(e => console.error('PID save error:', e));
    }, 200);
  },

  async savePidsNow(): Promise<void> {
    if (pidTimer) { clearTimeout(pidTimer); pidTimer = null; }
    pidDirty = false;
    pidChain = pidChain
      .then(() => persistenceService._writePids())
      .catch(e => console.error('PID save error:', e));
    return pidChain;
  },

  trackPid(pid: number): void {
    activePids.add(pid);
    persistenceService.scheduleSavePids();
  },

  untrackPid(pid: number): void {
    activePids.delete(pid);
    persistenceService.scheduleSavePids();
  },

  clearAllPids(): void {
    activePids.clear();
  },

  getActivePids(): Set<number> {
    return activePids;
  },

  // --- Load persisted data + orphan cleanup ---

  async load(): Promise<PersistedData | null> {
    // Kill orphaned processes from previous runs
    try {
      const pidFile = Bun.file(PID_FILE);
      if (await pidFile.exists()) {
        const pids: number[] = await pidFile.json();
        if (pids.length > 0) {
          console.log(`Cleaning up ${pids.length} orphaned PIDs from previous run:`, pids);
          await Promise.all(pids.map(pid => treeKill(pid)));
          await Bun.write(PID_FILE, '[]');
        }
      }
    } catch (e) {
      console.error('Failed to clean up orphaned PIDs:', e);
    }

    try {
      const file = Bun.file(DATA_FILE);
      if (await file.exists()) {
        return await file.json();
      }
    } catch (e) {
      console.error('Failed to load persisted data:', e);
    }
    return null;
  },
};
