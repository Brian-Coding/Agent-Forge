import { rename } from 'node:fs/promises';
import type { PersistedData } from '../../shared/protocol';
import { migrateAgentRecord } from '../../shared/protocol';
import { treeKill } from '../utils';
import { atomicWriteFile } from './atomic-file';

export const PERSISTED_SCHEMA_VERSION = 1;
const MAX_ORPHAN_PIDS = 256;
const MAX_ACTIVE_PIDS = 4_096;
const DEFAULT_MAX_DATA_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PID_BYTES = 64 * 1024;

export class UnsupportedPersistenceVersionError extends Error {
  constructor(public readonly version: unknown) {
    super(`Unsupported Agent Forge data schema version: ${String(version)}`);
    this.name = 'UnsupportedPersistenceVersionError';
  }
}

export interface PersistedDataNormalization {
  data: PersistedData;
  issues: string[];
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Normalize valid legacy state while isolating malformed individual records. */
export function normalizePersistedData(raw: unknown): PersistedDataNormalization {
  if (!isRecord(raw)) throw new Error('Agent Forge data must be a JSON object');
  const issues: string[] = [];
  const issue = (message: string) => {
    if (issues.length < 200) issues.push(message);
    else if (issues.length === 200) issues.push('Additional normalization issues were omitted');
  };
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== PERSISTED_SCHEMA_VERSION) {
    throw new UnsupportedPersistenceVersionError(raw.schemaVersion);
  }
  if (raw.schemaVersion === undefined) issue('schemaVersion was absent');

  const arrayField = (key: string, cap: number): any[] => {
    const value = raw[key];
    if (!Array.isArray(value)) {
      issue(`${key} was not an array`);
      return [];
    }
    if (value.length > cap) issue(`${key} exceeded ${cap} records and was capped`);
    return value.slice(0, cap);
  };
  const boundedString = (value: unknown, max: number, allowEmpty = true): string | null =>
    typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0) ? value : null;
  const boundedStrings = (
    value: unknown,
    maxItems: number,
    maxChars: number,
    allowEmpty = false,
  ): string[] => Array.isArray(value)
    ? value.slice(0, maxItems).filter((item): item is string =>
      typeof item === 'string' && item.length <= maxChars && (allowEmpty || item.length > 0))
    : [];
  const finiteNonNegative = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const finiteInteger = (value: unknown, min: number, max: number, fallback: number): number =>
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fallback;

  const agentIds = new Set<string>();
  const agents = arrayField('agents', 2_000).flatMap((candidate, index) => {
    if (!isRecord(candidate)
      || !boundedString(candidate.id, 256, false)
      || !boundedString(candidate.name, 256)
      || !boundedString(candidate.cwd, 32_768, false)
      || agentIds.has(candidate.id)) {
      issue(`agents[${index}] was malformed or duplicated`);
      return [];
    }
    agentIds.add(candidate.id);
    const migrated = migrateAgentRecord(candidate) as Record<string, any>;
    const referencePaths = boundedStrings(migrated.referencePaths, 128, 32_768);
    if (!Array.isArray(migrated.referencePaths) || referencePaths.length !== migrated.referencePaths.length) {
      issue(`agents[${index}].referencePaths was repaired`);
    }
    let systemPrompt = typeof migrated.systemPrompt === 'string' ? migrated.systemPrompt : '';
    if (systemPrompt.length > 1024 * 1024) {
      systemPrompt = systemPrompt.slice(0, 1024 * 1024);
      issue(`agents[${index}].systemPrompt was truncated`);
    }
    const sessionId = boundedString(migrated.currentSessionId, 1_024, false);
    const sessionProvider = sessionId && (migrated.currentSessionProvider === 'claude' || migrated.currentSessionProvider === 'codex')
      ? migrated.currentSessionProvider
      : null;
    const sessionModel = sessionProvider ? boundedString(migrated.currentSessionModel, 256, false) : null;
    const normalized: Record<string, any> = {
      id: candidate.id,
      name: candidate.name,
      cwd: candidate.cwd,
      referencePaths,
      systemPrompt,
      status: ['idle', 'working', 'thinking', 'error', 'stopped'].includes(migrated.status) ? migrated.status : 'stopped',
      createdAt: finiteNonNegative(migrated.createdAt) ?? 0,
      workspaceId: boundedString(migrated.workspaceId, 256) ?? '',
      currentSessionId: sessionProvider ? sessionId : null,
      currentSessionProvider: sessionProvider,
      currentSessionModel: sessionModel,
      contextTokens: finiteNonNegative(migrated.contextTokens),
      contextLimit: finiteNonNegative(migrated.contextLimit),
      totalInputTokens: finiteNonNegative(migrated.totalInputTokens),
      totalOutputTokens: finiteNonNegative(migrated.totalOutputTokens),
      totalCostUsd: finiteNonNegative(migrated.totalCostUsd),
      numTurns: finiteNonNegative(migrated.numTurns),
    };
    if (typeof migrated.hideFromGrid === 'boolean') normalized.hideFromGrid = migrated.hideFromGrid;
    if (migrated.provider === 'claude' || migrated.provider === 'codex') normalized.provider = migrated.provider;
    const model = boundedString(migrated.model, 256, false);
    if (model) normalized.model = model;
    const reasoningLevel = boundedString(migrated.reasoningLevel, 64, false);
    if (reasoningLevel) normalized.reasoningLevel = reasoningLevel;
    if (migrated.modelMismatch === null || isRecord(migrated.modelMismatch)) normalized.modelMismatch = migrated.modelMismatch ?? null;
    if (migrated.lastTurnOutcome === null || isRecord(migrated.lastTurnOutcome)) normalized.lastTurnOutcome = migrated.lastTurnOutcome ?? null;
    return [normalized];
  });

  const messageIds = new Set<string>();
  const messages = arrayField('messages', 200_000).flatMap((candidate, index) => {
    if (!isRecord(candidate)
      || !boundedString(candidate.id, 256, false)
      || messageIds.has(candidate.id)
      || !boundedString(candidate.agentId, 256, false)
      || !agentIds.has(candidate.agentId)
      || !['user', 'assistant', 'system'].includes(candidate.role)
      || typeof candidate.content !== 'string'
      || !finiteTimestamp(candidate.timestamp)) {
      issue(`messages[${index}] was malformed or duplicated`);
      return [];
    }
    messageIds.add(candidate.id);
    const message: Record<string, any> = {
      id: candidate.id,
      agentId: candidate.agentId,
      role: candidate.role,
      content: candidate.content.slice(0, 2 * 1024 * 1024),
      timestamp: candidate.timestamp,
    };
    if (candidate.content.length > message.content.length) issue(`messages[${index}].content was truncated`);
    if (typeof candidate.imageData === 'string' && candidate.imageData.length <= 16 * 1024 * 1024) message.imageData = candidate.imageData;
    else if (candidate.imageData !== undefined) issue(`messages[${index}].imageData was dropped`);
    const imageMimeType = boundedString(candidate.imageMimeType, 128, false);
    if (imageMimeType) message.imageMimeType = imageMimeType;
    if (Array.isArray(candidate.imageAttachments)) {
      const attachments = candidate.imageAttachments.slice(0, 100).flatMap((attachment: unknown) => {
        if (!isRecord(attachment)
          || !boundedString(attachment.path, 32_768, false)
          || !boundedString(attachment.name, 256, false)
          || !boundedString(attachment.mimeType, 128, false)
          || !Number.isSafeInteger(attachment.size) || attachment.size <= 0) return [];
        return [{ path: attachment.path, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size }];
      });
      if (attachments.length !== candidate.imageAttachments.length) issue(`messages[${index}].imageAttachments was repaired`);
      if (attachments.length > 0) message.imageAttachments = attachments;
    }
    if (candidate.source === 'qa') message.source = 'qa';
    if (candidate.provider === 'claude' || candidate.provider === 'codex') message.provider = candidate.provider;
    const messageModel = boundedString(candidate.model, 256, false);
    if (messageModel) message.model = messageModel;
    return [message as any];
  });

  const documentIds = new Set<string>();
  const documents = arrayField('documents', 5_000).flatMap((candidate, index) => {
    if (!isRecord(candidate)
      || !boundedString(candidate.id, 256, false)
      || documentIds.has(candidate.id)
      || !boundedString(candidate.title, 512)
      || typeof candidate.content !== 'string') {
      issue(`documents[${index}] was malformed or duplicated`);
      return [];
    }
    documentIds.add(candidate.id);
    const document: Record<string, any> = {
      id: candidate.id,
      title: candidate.title,
      content: candidate.content.slice(0, 2 * 1024 * 1024),
      lastEditedBy: boundedString(candidate.lastEditedBy, 256) ?? 'user',
      status: ['draft', 'approved', 'in_progress'].includes(candidate.status) ? candidate.status : 'draft',
      createdAt: finiteNonNegative(candidate.createdAt) ?? 0,
      updatedAt: finiteNonNegative(candidate.updatedAt) ?? 0,
    };
    if (candidate.content.length > document.content.length) issue(`documents[${index}].content was truncated`);
    for (const key of ['agentId', 'workspaceId'] as const) {
      const value = boundedString(candidate[key], 256, false);
      if (value) document[key] = value;
    }
    const filePath = boundedString(candidate.filePath, 32_768, false);
    if (filePath) document.filePath = filePath;
    return [document as any];
  });

  const normalizeQaRun = (candidate: unknown, path: string): Record<string, any> | null => {
    if (!isRecord(candidate)
      || !boundedString(candidate.id, 256, false)
      || !boundedString(candidate.sourceAgentId, 256, false)
      || typeof candidate.prompt !== 'string'
      || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(candidate.status)
      || !boundedString(candidate.browserSessionId, 256, false)
      || finiteNonNegative(candidate.createdAt) === undefined) {
      issue(`${path} was malformed`);
      return null;
    }
    const run: Record<string, any> = {
      id: candidate.id,
      sourceAgentId: candidate.sourceAgentId,
      prompt: candidate.prompt.slice(0, 1024 * 1024),
      status: candidate.status,
      browserSessionId: candidate.browserSessionId,
      createdAt: candidate.createdAt,
    };
    for (const key of ['startedAt', 'finishedAt', 'handoffStartedAt', 'handedOffAt'] as const) {
      const value = finiteNonNegative(candidate[key]);
      if (value !== undefined) run[key] = value;
    }
    for (const key of ['rerunOf', 'verdict', 'summary', 'report', 'error', 'handoffError'] as const) {
      const value = boundedString(candidate[key], key === 'report' ? 2 * 1024 * 1024 : 100_000, false);
      if (value) run[key] = value;
    }
    const validationErrors = boundedStrings(candidate.validationErrors, 1_000, 10_000);
    if (validationErrors.length > 0) run.validationErrors = validationErrors;
    for (const key of ['assertions', 'evidence', 'findings'] as const) {
      if (Array.isArray(candidate[key])) run[key] = candidate[key].slice(0, 1_000).filter(isRecord);
    }
    if (isRecord(candidate.usage)) {
      run.usage = {
        inputTokens: finiteNonNegative(candidate.usage.inputTokens) ?? 0,
        outputTokens: finiteNonNegative(candidate.usage.outputTokens) ?? 0,
        costUsd: finiteNonNegative(candidate.usage.costUsd) ?? 0,
      };
    }
    return run;
  };

  const normalizeAtlasRun = (candidate: unknown, path: string): Record<string, any> | null => {
    const runId = isRecord(candidate) ? boundedString(candidate.id, 96, false) : null;
    if (!isRecord(candidate)
      || !runId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(runId)
      || (candidate.mode !== 'build' && candidate.mode !== 'rescan')
      || !['running', 'validating', 'paused', 'failed', 'completed', 'cancelled'].includes(candidate.status)
      || !boundedString(candidate.browserSessionId, 256, false)
      || finiteNonNegative(candidate.createdAt) === undefined
      || finiteNonNegative(candidate.startedAt) === undefined
      || finiteNonNegative(candidate.lastActivityAt) === undefined) {
      issue(`${path} was malformed`);
      return null;
    }
    const run: Record<string, any> = {
      id: runId,
      mode: candidate.mode,
      status: candidate.status,
      candidateRelPath: `docs/.agent-forge-atlas-candidates/${runId}`,
      browserSessionId: candidate.browserSessionId,
      createdAt: candidate.createdAt,
      startedAt: candidate.startedAt,
      lastActivityAt: candidate.lastActivityAt,
    };
    if (candidate.candidateRelPath !== run.candidateRelPath) issue(`${path}.candidateRelPath was repaired`);
    for (const key of ['finishedAt', 'surfaceCount', 'entityCount', 'verifiedSurfaceCount', 'resumeCount'] as const) {
      const value = finiteNonNegative(candidate[key]);
      if (value !== undefined) run[key] = value;
    }
    for (const key of ['phase', 'error'] as const) {
      const value = boundedString(candidate[key], 100_000, false);
      if (value) run[key] = value;
    }
    const validationErrors = boundedStrings(candidate.validationErrors, 1_000, 10_000);
    if (validationErrors.length > 0) run.validationErrors = validationErrors;
    return run;
  };

  const workspaceIds = new Set<string>();
  const workspaces = arrayField('workspaces', 2_000).flatMap((candidate, index) => {
    if (!isRecord(candidate)
      || !boundedString(candidate.id, 256, false)
      || workspaceIds.has(candidate.id)
      || !boundedString(candidate.name, 256)) {
      issue(`workspaces[${index}] was malformed or duplicated`);
      return [];
    }
    workspaceIds.add(candidate.id);
    const selectedAgentIds = boundedStrings(candidate.selectedAgentIds, 1_024, 256, true);
    const lockedAgentIds = boundedStrings(candidate.lockedAgentIds, 1_024, 256);
    const qaRuns = Array.isArray(candidate.qaRuns)
      ? candidate.qaRuns.slice(0, 100).flatMap((run: unknown, runIndex: number) => {
        const normalized = normalizeQaRun(run, `workspaces[${index}].qaRuns[${runIndex}]`);
        return normalized ? [normalized] : [];
      })
      : [];
    const workspace: Record<string, any> = {
      id: candidate.id,
      name: candidate.name,
      sortOrder: finiteNonNegative(candidate.sortOrder) ?? index,
      gridColumns: finiteInteger(candidate.gridColumns, 1, 12, 3),
      gridRows: finiteInteger(candidate.gridRows, 1, 12, 2),
      selectedAgentIds,
      lockedAgentIds,
      createdAt: finiteNonNegative(candidate.createdAt) ?? 0,
      googleDocsTrackerEnabled: candidate.googleDocsTrackerEnabled === true,
      qaRuns,
    };
    for (const key of ['testUrl', 'qaAgentId', 'atlasAgentId'] as const) {
      const value = boundedString(candidate[key], key === 'testUrl' ? 8_192 : 256, false);
      if (value) workspace[key] = value;
    }
    const atlasProjectCwd = boundedString(candidate.atlasProjectCwd, 32_768, false);
    if (atlasProjectCwd) workspace.atlasProjectCwd = atlasProjectCwd;
    const atlasLastScanAt = finiteNonNegative(candidate.atlasLastScanAt);
    if (atlasLastScanAt !== undefined) workspace.atlasLastScanAt = atlasLastScanAt;
    if (candidate.atlasRun !== undefined) {
      const atlasRun = normalizeAtlasRun(candidate.atlasRun, `workspaces[${index}].atlasRun`);
      if (atlasRun) workspace.atlasRun = atlasRun;
    }
    if (isRecord(candidate.qaSurfaceVerifications)) {
      const verifications: Record<string, number> = {};
      for (const [key, value] of Object.entries(candidate.qaSurfaceVerifications).slice(0, 10_000)) {
        if (key.length <= 256 && finiteNonNegative(value) !== undefined) verifications[key] = value;
      }
      if (Object.keys(verifications).length > 0) workspace.qaSurfaceVerifications = verifications;
    }
    return [workspace as any];
  });

  const usageEvents = raw.usageEvents === undefined
    ? undefined
    : Array.isArray(raw.usageEvents)
      ? (raw.usageEvents.length > 500_000 && issue('usageEvents exceeded 500000 records and was capped'), raw.usageEvents.slice(0, 500_000))
      : (issue('usageEvents was not an array'), []);

  if (typeof raw.sharedContext !== 'string') issue('sharedContext was not a string');
  if (!isRecord(raw.settings)) issue('settings was not an object');
  let sharedContext = typeof raw.sharedContext === 'string' ? raw.sharedContext : '';
  if (sharedContext.length > 1024 * 1024) {
    sharedContext = sharedContext.slice(0, 1024 * 1024);
    issue('sharedContext was truncated');
  }
  const settingsRaw = isRecord(raw.settings) ? raw.settings : {};
  const settings: Record<string, any> = {};
  for (const key of ['defaultSimulatorUdid', 'defaultSimulatorName', 'activeWorkspaceId'] as const) {
    const value = boundedString(settingsRaw[key], 256, false);
    if (value) settings[key] = value;
  }
  if (settingsRaw.sidebarWidth !== undefined) settings.sidebarWidth = finiteInteger(settingsRaw.sidebarWidth, 100, 2_000, 240);
  if (settingsRaw.gridColumns !== undefined) settings.gridColumns = finiteInteger(settingsRaw.gridColumns, 1, 12, 2);
  if (settingsRaw.gridRows !== undefined) settings.gridRows = finiteInteger(settingsRaw.gridRows, 1, 12, 2);
  if (settingsRaw.selectedAgentIds !== undefined) settings.selectedAgentIds = boundedStrings(settingsRaw.selectedAgentIds, 1_024, 256, true);

  return {
    data: {
      schemaVersion: PERSISTED_SCHEMA_VERSION,
      agents: agents as any,
      messages,
      sharedContext,
      documents,
      settings,
      workspaces,
      ...(usageEvents === undefined ? {} : { usageEvents: usageEvents as any }),
    },
    issues,
  };
}

export interface PersistenceServiceOptions {
  dataFile?: string;
  pidFile?: string;
  activePids?: Set<number>;
  debounceMs?: number;
  writeFile?: typeof atomicWriteFile;
  killTree?: typeof treeKill;
  now?: () => number;
  maxDataBytes?: number;
  maxPidBytes?: number;
}

export interface PersistenceService {
  setBuildPersistedData(fn: () => PersistedData): void;
  _writeData(): Promise<void>;
  save(): void;
  saveNow(): Promise<void>;
  _writePids(): Promise<void>;
  scheduleSavePids(): void;
  savePidsNow(): Promise<void>;
  trackPid(pid: number): void;
  untrackPid(pid: number): void;
  clearAllPids(): void;
  getActivePids(): Set<number>;
  load(): Promise<PersistedData | null>;
}

export function createPersistenceService(options: PersistenceServiceOptions = {}): PersistenceService {
  const dataFile = options.dataFile ?? './data.json';
  const pidFile = options.pidFile ?? './pids.json';
  const activePids = options.activePids ?? new Set<number>();
  const debounceMs = options.debounceMs ?? 200;
  const writeFile = options.writeFile ?? atomicWriteFile;
  const killTree = options.killTree ?? treeKill;
  const now = options.now ?? Date.now;
  const maxDataBytes = Number.isSafeInteger(options.maxDataBytes) && (options.maxDataBytes ?? -1) >= 0
    ? options.maxDataBytes!
    : DEFAULT_MAX_DATA_BYTES;
  const maxPidBytes = Number.isSafeInteger(options.maxPidBytes) && (options.maxPidBytes ?? -1) >= 0
    ? options.maxPidBytes!
    : DEFAULT_MAX_PID_BYTES;

  let persistChain: Promise<void> = Promise.resolve();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistDirty = false;
  let pendingDataSnapshot: string | null | undefined;
  let pidChain: Promise<void> = Promise.resolve();
  let pidTimer: ReturnType<typeof setTimeout> | null = null;
  let pidDirty = false;
  let buildPersistedData: (() => PersistedData) | null = null;

  const serializeDataSnapshot = (): string | null => {
    if (!buildPersistedData) return null;
    const data = buildPersistedData();
    const serialized = JSON.stringify(data, null, 2);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > maxDataBytes) {
      throw new Error(`Refusing to persist ${bytes} bytes; data limit is ${maxDataBytes} bytes`);
    }
    return serialized;
  };

  const writeDataSnapshot = async (serialized: string | null): Promise<void> => {
    if (serialized === null) return;
    await writeFile(dataFile, serialized);
  };

  const preserveByRename = async (path: string, label: string): Promise<string> => {
    const backup = `${path}.${label}-${now()}`;
    try {
      await rename(path, backup);
      return backup;
    } catch (error) {
      throw new Error(`Could not preserve unreadable state at ${path}; refusing to continue`, { cause: error });
    }
  };

  const service: PersistenceService = {
    setBuildPersistedData(fn) {
      buildPersistedData = fn;
    },

    async _writeData() {
      try {
        await writeDataSnapshot(serializeDataSnapshot());
      } catch (error) {
        persistDirty = true;
        console.error('Failed to persist data:', error);
        throw error;
      }
    },

    save() {
      try {
        // A save request owns the state visible at this call. Building later
        // inside the debounce callback could capture an unrelated mutation
        // that subsequently rolls back, making failed state durable.
        pendingDataSnapshot = serializeDataSnapshot();
        persistDirty = true;
      } catch (error) {
        persistDirty = true;
        console.error('Failed to prepare persisted data:', error);
        return;
      }
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = null;
        if (!persistDirty) return;
        persistDirty = false;
        const snapshot = pendingDataSnapshot;
        pendingDataSnapshot = undefined;
        persistChain = persistChain
          .then(() => writeDataSnapshot(snapshot ?? null))
          .catch(error => {
            persistDirty = true;
            console.error('Persist error:', error);
          });
      }, debounceMs);
    },

    async saveNow() {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      persistDirty = false;
      pendingDataSnapshot = undefined;
      // Capture the state at the durability boundary, not later when an older
      // queued write happens to finish. Otherwise that older operation can
      // accidentally persist a newer operation that has not committed yet.
      let snapshot: string | null;
      try {
        snapshot = serializeDataSnapshot();
      } catch (error) {
        persistDirty = true;
        console.error('Failed to persist data:', error);
        throw error;
      }
      const write = persistChain.then(async () => {
        try {
          await writeDataSnapshot(snapshot);
        } catch (error) {
          persistDirty = true;
          console.error('Failed to persist data:', error);
          throw error;
        }
      });
      persistChain = write.catch(() => {});
      return write;
    },

    async _writePids() {
      try {
        const serialized = JSON.stringify([...activePids]);
        const bytes = Buffer.byteLength(serialized, 'utf8');
        if (bytes > maxPidBytes) throw new Error(`Refusing to persist ${bytes} PID bytes; limit is ${maxPidBytes}`);
        await writeFile(pidFile, serialized);
      } catch (error) {
        pidDirty = true;
        console.error('Failed to save PIDs:', error);
        throw error;
      }
    },

    scheduleSavePids() {
      pidDirty = true;
      if (pidTimer) return;
      pidTimer = setTimeout(() => {
        pidTimer = null;
        if (!pidDirty) return;
        pidDirty = false;
        pidChain = pidChain
          .then(() => service._writePids())
          .catch(error => console.error('PID save error:', error));
      }, debounceMs);
    },

    async savePidsNow() {
      if (pidTimer) {
        clearTimeout(pidTimer);
        pidTimer = null;
      }
      pidDirty = false;
      const write = pidChain.then(() => service._writePids());
      pidChain = write.catch(() => {});
      return write;
    },

    trackPid(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
      if (!activePids.has(pid) && activePids.size >= MAX_ACTIVE_PIDS) {
        console.error(`[persistence] refusing to track PID ${pid}: active PID registry reached ${MAX_ACTIVE_PIDS}`);
        return;
      }
      activePids.add(pid);
      service.scheduleSavePids();
    },

    untrackPid(pid) {
      activePids.delete(pid);
      service.scheduleSavePids();
    },

    clearAllPids() {
      activePids.clear();
    },

    getActivePids() {
      return new Set(activePids);
    },

    async load() {
      const pidFileHandle = Bun.file(pidFile);
      if (await pidFileHandle.exists()) {
        let parsedPids: unknown;
        if (pidFileHandle.size > maxPidBytes) {
          const backup = await preserveByRename(pidFile, 'oversized');
          console.error(`[persistence] preserved oversized PID file at ${backup}; limit is ${maxPidBytes} bytes`);
          parsedPids = [];
        } else {
          try {
            parsedPids = JSON.parse(await pidFileHandle.text());
          } catch (error) {
            const backup = await preserveByRename(pidFile, 'corrupt');
            console.error(`[persistence] preserved corrupt PID file at ${backup}:`, error);
            parsedPids = [];
          }
        }

        const rawPids = Array.isArray(parsedPids) ? parsedPids : [];
        const pids = [...new Set(rawPids.filter((pid): pid is number =>
          Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid,
        ))].slice(0, MAX_ORPHAN_PIDS);
        if (!Array.isArray(parsedPids) || pids.length !== rawPids.length) {
          console.error('[persistence] ignored malformed, duplicate, self, or excessive orphan PID records');
        }
        if (pids.length > 0) {
          console.log(`Cleaning up ${pids.length} orphaned PIDs from previous run.`);
          await Promise.allSettled(pids.map(pid => killTree(pid)));
        }
        // Never leave already-attempted or malformed PID records behind where
        // OS PID reuse could target an unrelated future process.
        activePids.clear();
        await service.savePidsNow();
      }

      const file = Bun.file(dataFile);
      if (!(await file.exists())) return null;
      if (file.size > maxDataBytes) {
        const backup = await preserveByRename(dataFile, 'oversized');
        console.error(`[persistence] preserved oversized data file at ${backup}; limit is ${maxDataBytes} bytes`);
        return null;
      }

      let rawText: string;
      try {
        rawText = await file.text();
      } catch (error) {
        const backup = await preserveByRename(dataFile, 'unreadable');
        console.error(`[persistence] preserved unreadable data file at ${backup}:`, error);
        return null;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch (error) {
        const backup = await preserveByRename(dataFile, 'corrupt');
        console.error(`[persistence] preserved corrupt data file at ${backup}:`, error);
        return null;
      }

      let normalized: PersistedDataNormalization;
      try {
        normalized = normalizePersistedData(raw);
      } catch (error) {
        if (error instanceof UnsupportedPersistenceVersionError) {
          const backup = `${dataFile}.unsupported-${now()}`;
          await writeFile(backup, rawText);
          throw new Error(`${error.message}. Original state was preserved at ${backup}.`);
        }
        const backup = await preserveByRename(dataFile, 'invalid');
        console.error(`[persistence] preserved invalid data file at ${backup}:`, error);
        return null;
      }

      if (normalized.issues.length > 0) {
        const backup = `${dataFile}.recovery-${now()}`;
        await writeFile(backup, rawText);
        console.error(`[persistence] repaired ${normalized.issues.length} state issue(s); original preserved at ${backup}: ${normalized.issues.join('; ')}`);
        const repaired = JSON.stringify(normalized.data, null, 2);
        if (Buffer.byteLength(repaired, 'utf8') > maxDataBytes) {
          throw new Error(`Repaired persistence state exceeds ${maxDataBytes} bytes; original preserved at ${backup}`);
        }
        await writeFile(dataFile, repaired);
      }
      return normalized.data;
    },
  };

  return service;
}

const activePids: Set<number> = (globalThis as any).__activePids ??= new Set<number>();

export const persistenceService = createPersistenceService({ activePids });
