import type { PersistedData } from '../../shared/protocol';
import { migrateAgentRecord } from '../../shared/protocol';
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
      // Re-arm so a later save() retries, and rethrow so saveNow() callers
      // (notably the shutdown flush) learn the write failed instead of
      // believing data was saved — common on OneDrive/Windows EPERM locks.
      persistDirty = true;
      throw e;
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
    // `write` reflects this write's real outcome and is returned to the caller
    // (rejects on failure). persistChain is kept resolved so a failed write
    // doesn't poison the serialized chain and block all future saves.
    const write = persistChain.then(() => persistenceService._writeData());
    persistChain = write.catch(() => {});
    return write;
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
        const raw = await file.json();
        // Migrate each agent record (legacy sessionId → sessionIds.claude, default provider).
        // Idempotent on subsequent loads.
        if (raw && Array.isArray(raw.agents)) {
          let migrated = 0;
          raw.agents = raw.agents.map((a: any) => {
            const before = JSON.stringify(a);
            const after = migrateAgentRecord(a);
            if (JSON.stringify(after) !== before) migrated++;
            return after;
          });
          if (migrated > 0) {
            console.log(`[persistence] migrated ${migrated} agent record(s) to unified session model (currentSessionId + currentSessionProvider)`);
          }
        }
        return raw as PersistedData;
      }
    } catch (e) {
      console.error('Failed to load persisted data:', e);
      // The file exists but is unreadable/corrupt (e.g. truncated by a crash
      // mid-write). Preserve it before the first mutation calls saveNow() and
      // overwrites recoverable bytes with empty state.
      try {
        const { renameSync, existsSync } = await import('fs');
        if (existsSync(DATA_FILE)) {
          const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
          renameSync(DATA_FILE, backup);
          console.error(`[persistence] preserved corrupt data file at ${backup}`);
        }
      } catch (backupErr) {
        console.error('Failed to back up corrupt data file:', backupErr);
      }
    }
    return null;
  },
};
