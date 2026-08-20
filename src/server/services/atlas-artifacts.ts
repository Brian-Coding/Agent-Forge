import { existsSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeMoveDirectory, safeRemoveTree } from './safe-filesystem.mjs';

export const ATLAS_SCHEMA_VERSION = 1;
export const ATLAS_CANDIDATES_DIR = 'docs/.agent-forge-atlas-candidates';
const ATLAS_CLEANUP_MAX_ENTRIES = 100_000;
const ATLAS_BUNDLE_TOP_LEVEL_NAMES = [
  '.history',
  'atlas.md',
  'atlas.json',
  'manifest.json',
  'checkpoint.json',
  'changelog.md',
  'README.md',
  'shots',
] as const;

interface AtlasSurfaceRecord {
  id: string;
  name: string;
  status: 'verified' | 'partial' | 'unverified' | 'excluded';
  screenshotRefs?: string[];
  entityIds?: string[];
  codeRefs?: string[];
  states?: string[];
  actions?: string[];
}

interface AtlasEntityRecord {
  id: string;
  name: string;
  fields?: string[];
  codeRefs?: string[];
}

interface AtlasFlowRecord {
  id: string;
  name: string;
  fromSurfaceId: string;
  toSurfaceId: string;
  trigger?: string;
}

interface AtlasGraph {
  schemaVersion: number;
  runId: string;
  generatedAt: string;
  surfaces: AtlasSurfaceRecord[];
  entities: AtlasEntityRecord[];
  flows?: AtlasFlowRecord[];
}

interface AtlasManifest {
  schemaVersion: number;
  atlasSchemaVersion: number;
  runId: string;
  status: string;
  generatedAt: string;
}

interface AtlasCheckpoint {
  schemaVersion: number;
  runId: string;
  status: string;
  phase?: string;
  completedSurfaceIds?: string[];
  lastActivityAt?: string;
}

export interface AtlasValidationResult {
  valid: boolean;
  errors: string[];
  surfaceCount: number;
  entityCount: number;
  verifiedSurfaceCount: number;
  generatedAt?: number;
}

export interface AtlasCandidatePaths {
  projectRoot: string;
  docsRoot: string;
  canonicalRoot: string;
  candidatesRoot: string;
  candidateRoot: string;
  candidateRelPath: string;
}

function safeRunId(runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(runId)) throw new Error('Invalid Atlas run ID');
  return runId;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertInside(root: string, target: string, label: string): void {
  if (!isInside(root, target)) throw new Error(`${label} escaped its allowed root`);
}

export function atlasCandidatePaths(projectRoot: string, runId: string): AtlasCandidatePaths {
  const safeId = safeRunId(runId);
  const root = resolve(projectRoot);
  const docsRoot = join(root, 'docs');
  const candidatesRoot = join(root, ...ATLAS_CANDIDATES_DIR.split('/'));
  const candidateRoot = join(candidatesRoot, safeId);
  assertInside(candidatesRoot, candidateRoot, 'Atlas candidate');
  return {
    projectRoot: root,
    docsRoot,
    canonicalRoot: join(docsRoot, 'ui-atlas'),
    candidatesRoot,
    candidateRoot,
    candidateRelPath: relative(root, candidateRoot).split(sep).join('/'),
  };
}

export async function createAtlasCandidate(projectRoot: string, runId: string): Promise<AtlasCandidatePaths> {
  const paths = atlasCandidatePaths(projectRoot, runId);
  await mkdir(join(paths.candidateRoot, 'shots'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(paths.candidateRoot, 'checkpoint.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    status: 'running',
    phase: 'preparing',
    completedSurfaceIds: [],
    lastActivityAt: now,
  }, null, 2));
  await writeFile(join(paths.candidateRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    atlasSchemaVersion: ATLAS_SCHEMA_VERSION,
    runId,
    status: 'running',
    generatedAt: now,
  }, null, 2));
  return paths;
}

async function readJson<T>(filePath: string, errors: string[], label: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${label} is missing or invalid JSON: ${message}`);
    return null;
  }
}

function validStableId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}\\.[a-z0-9][a-z0-9-]*$`).test(value);
}

function parseFrontmatterCount(markdown: string, key: string): number | null {
  const match = markdown.match(new RegExp(`^${key}:\\s*(\\d+)\\s*$`, 'm'));
  return match ? Number(match[1]) : null;
}

function parseFrontmatterValue(markdown: string, key: string): string | null {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return match ? match[1]!.trim() : null;
}

function safeEvidencePath(candidateRoot: string, ref: string): string | null {
  if (!ref || isAbsolute(ref)) return null;
  const resolved = resolve(candidateRoot, ref);
  return isInside(candidateRoot, resolved) ? resolved : null;
}

async function inspectPngEvidence(candidateRoot: string, ref: string): Promise<string | null> {
  if (!/^shots\/[a-zA-Z0-9._/-]+\.png$/i.test(ref)) return 'must be a candidate-relative shots/*.png path';
  const evidencePath = safeEvidencePath(candidateRoot, ref);
  if (!evidencePath) return 'escapes the candidate directory';
  try {
    const [realRoot, realEvidence, info] = await Promise.all([
      realpath(candidateRoot),
      realpath(evidencePath),
      stat(evidencePath),
    ]);
    if (!isInside(realRoot, realEvidence)) return 'resolves outside the candidate directory';
    if (!info.isFile() || info.size < 8) return 'is not a valid PNG file';
    const handle = await open(evidencePath, 'r');
    try {
      const signature = Buffer.alloc(8);
      const { bytesRead } = await handle.read(signature, 0, 8, 0);
      const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (bytesRead !== 8 || !signature.equals(expected)) return 'does not have a PNG signature';
    } finally {
      await handle.close();
    }
    return null;
  } catch {
    return 'does not exist or cannot be resolved';
  }
}

export async function validateAtlasCandidate(projectRoot: string, runId: string): Promise<AtlasValidationResult> {
  const paths = atlasCandidatePaths(projectRoot, runId);
  const errors: string[] = [];
  const markdownPath = join(paths.candidateRoot, 'atlas.md');
  const graphPath = join(paths.candidateRoot, 'atlas.json');
  const manifestPath = join(paths.candidateRoot, 'manifest.json');
  const checkpointPath = join(paths.candidateRoot, 'checkpoint.json');

  try {
    const rootInfo = await lstat(paths.candidateRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) errors.push('Atlas candidate root must be a real directory, not a symlink');
  } catch {
    errors.push('Atlas candidate directory is missing');
  }

  for (const name of ['atlas.md', 'atlas.json', 'manifest.json', 'checkpoint.json', 'README.md', 'changelog.md']) {
    const filePath = join(paths.candidateRoot, name);
    if (!existsSync(filePath)) continue;
    try {
      const [info, realRoot, realFile] = await Promise.all([
        lstat(filePath),
        realpath(paths.candidateRoot),
        realpath(filePath),
      ]);
      if (!info.isFile() || info.isSymbolicLink() || !isInside(realRoot, realFile)) {
        errors.push(`${name} must be a regular file inside the Atlas candidate`);
      }
    } catch {
      errors.push(`${name} could not be safely resolved`);
    }
  }

  let markdown = '';
  try {
    markdown = await readFile(markdownPath, 'utf8');
    if (markdown.trim().length < 100) errors.push('atlas.md is too small to be a completed Atlas');
  } catch {
    errors.push('atlas.md is missing');
  }

  const graph = await readJson<AtlasGraph>(graphPath, errors, 'atlas.json');
  const manifest = await readJson<AtlasManifest>(manifestPath, errors, 'manifest.json');
  const checkpoint = await readJson<AtlasCheckpoint>(checkpointPath, errors, 'checkpoint.json');

  for (const name of ['README.md', 'changelog.md']) {
    try {
      if ((await readFile(join(paths.candidateRoot, name), 'utf8')).trim().length === 0) {
        errors.push(`${name} must not be empty`);
      }
    } catch {
      errors.push(`${name} is missing`);
    }
  }

  if (manifest) {
    if (manifest.schemaVersion !== 1) errors.push('manifest.json schemaVersion must be 1');
    if (manifest.atlasSchemaVersion !== ATLAS_SCHEMA_VERSION) errors.push(`manifest.json atlasSchemaVersion must be ${ATLAS_SCHEMA_VERSION}`);
    if (manifest.runId !== runId) errors.push('manifest.json runId does not match this run');
    if (manifest.status !== 'complete') errors.push('manifest.json status must be complete before publication');
  }
  if (checkpoint) {
    if (checkpoint.schemaVersion !== 1) errors.push('checkpoint.json schemaVersion must be 1');
    if (checkpoint.runId !== runId) errors.push('checkpoint.json runId does not match this run');
    if (checkpoint.status !== 'complete') errors.push('checkpoint.json status must be complete before publication');
    if (!Array.isArray(checkpoint.completedSurfaceIds)) errors.push('checkpoint.json completedSurfaceIds must be an array');
    if (!checkpoint.lastActivityAt || !Number.isFinite(Date.parse(checkpoint.lastActivityAt))) {
      errors.push('checkpoint.json lastActivityAt must be an ISO timestamp');
    }
  }

  let surfaceCount = 0;
  let entityCount = 0;
  let verifiedSurfaceCount = 0;
  if (graph) {
    if (graph.schemaVersion !== ATLAS_SCHEMA_VERSION) errors.push(`atlas.json schemaVersion must be ${ATLAS_SCHEMA_VERSION}`);
    if (graph.runId !== runId) errors.push('atlas.json runId does not match this run');
    if (!graph.generatedAt || !Number.isFinite(Date.parse(graph.generatedAt))) errors.push('atlas.json generatedAt must be an ISO timestamp');
    if (!Array.isArray(graph.surfaces) || graph.surfaces.length === 0) errors.push('atlas.json must contain at least one surface');
    if (!Array.isArray(graph.entities)) errors.push('atlas.json entities must be an array');
    if (graph.flows !== undefined && !Array.isArray(graph.flows)) errors.push('atlas.json flows must be an array when present');

    const surfaces = Array.isArray(graph.surfaces) ? graph.surfaces : [];
    const entities = Array.isArray(graph.entities) ? graph.entities : [];
    const flows = Array.isArray(graph.flows) ? graph.flows : [];
    surfaceCount = surfaces.length;
    entityCount = entities.length;
    verifiedSurfaceCount = surfaces.filter(surface => surface?.status === 'verified').length;

    const surfaceIds = new Set<string>();
    const entityIds = new Set<string>();
    for (const entity of entities) {
      if (!validStableId(entity?.id, 'entity')) errors.push(`Invalid entity ID: ${String(entity?.id)}`);
      else if (entityIds.has(entity.id)) errors.push(`Duplicate entity ID: ${entity.id}`);
      else entityIds.add(entity.id);
      if (typeof entity?.name !== 'string' || !entity.name.trim()) errors.push(`Entity ${String(entity?.id)} has no name`);
    }

    for (const surface of surfaces) {
      if (!validStableId(surface?.id, 'surface')) errors.push(`Invalid surface ID: ${String(surface?.id)}`);
      else if (surfaceIds.has(surface.id)) errors.push(`Duplicate surface ID: ${surface.id}`);
      else surfaceIds.add(surface.id);
      if (typeof surface?.name !== 'string' || !surface.name.trim()) errors.push(`Surface ${String(surface?.id)} has no name`);
      if (!['verified', 'partial', 'unverified', 'excluded'].includes(surface?.status)) {
        errors.push(`Surface ${String(surface?.id)} has invalid status`);
      }
      const screenshotRefs = Array.isArray(surface?.screenshotRefs) ? surface.screenshotRefs : [];
      if (surface?.status === 'verified' && screenshotRefs.length === 0) {
        errors.push(`Verified surface ${String(surface?.id)} has no screenshot evidence`);
      }
      for (const ref of screenshotRefs) {
        if (typeof ref !== 'string') {
          errors.push(`Surface ${String(surface?.id)} has unsafe screenshot ref: ${String(ref)}`);
          continue;
        }
        const issue = await inspectPngEvidence(paths.candidateRoot, ref);
        if (issue) errors.push(`Surface ${String(surface?.id)} screenshot ${ref} ${issue}`);
      }
      for (const entityId of Array.isArray(surface?.entityIds) ? surface.entityIds : []) {
        if (!entityIds.has(entityId)) errors.push(`Surface ${String(surface?.id)} references unknown entity: ${entityId}`);
      }
    }

    const flowIds = new Set<string>();
    for (const flow of flows) {
      if (!validStableId(flow?.id, 'flow')) errors.push(`Invalid flow ID: ${String(flow?.id)}`);
      else if (flowIds.has(flow.id)) errors.push(`Duplicate flow ID: ${flow.id}`);
      else flowIds.add(flow.id);
      if (!surfaceIds.has(flow?.fromSurfaceId)) errors.push(`Flow ${String(flow?.id)} has unknown fromSurfaceId`);
      if (!surfaceIds.has(flow?.toSurfaceId)) errors.push(`Flow ${String(flow?.id)} has unknown toSurfaceId`);
      if (typeof flow?.name !== 'string' || !flow.name.trim()) errors.push(`Flow ${String(flow?.id)} has no name`);
    }

    if (checkpoint && Array.isArray(checkpoint.completedSurfaceIds)) {
      const completedIds = new Set(checkpoint.completedSurfaceIds);
      if (completedIds.size !== checkpoint.completedSurfaceIds.length) errors.push('checkpoint.json completedSurfaceIds contains duplicates');
      for (const completedId of completedIds) {
        if (!surfaceIds.has(completedId)) errors.push(`checkpoint.json references unknown completed surface: ${completedId}`);
      }
      for (const surfaceId of surfaceIds) {
        if (!completedIds.has(surfaceId)) errors.push(`checkpoint.json does not mark ${surfaceId} complete`);
      }
    }
  }

  if (markdown) {
    const markdownSchema = parseFrontmatterCount(markdown, 'schema_version');
    if (markdownSchema !== ATLAS_SCHEMA_VERSION) errors.push(`atlas.md schema_version must be ${ATLAS_SCHEMA_VERSION}`);
    const lastFullScan = parseFrontmatterValue(markdown, 'last_full_scan');
    if (!lastFullScan || !Number.isFinite(Date.parse(lastFullScan))) errors.push('atlas.md last_full_scan must be an ISO timestamp');
    const markdownSurfaces = parseFrontmatterCount(markdown, 'total_surfaces');
    const markdownEntities = parseFrontmatterCount(markdown, 'total_entities');
    if (markdownSurfaces == null) errors.push('atlas.md frontmatter is missing total_surfaces');
    else if (graph && markdownSurfaces !== surfaceCount) errors.push(`atlas.md total_surfaces (${markdownSurfaces}) does not match atlas.json (${surfaceCount})`);
    if (markdownEntities == null) errors.push('atlas.md frontmatter is missing total_entities');
    else if (graph && markdownEntities !== entityCount) errors.push(`atlas.md total_entities (${markdownEntities}) does not match atlas.json (${entityCount})`);

    for (const match of markdown.matchAll(/(?:`|\()?(shots\/[a-zA-Z0-9._/-]+\.png)(?:`|\))?/g)) {
      const ref = match[1]!;
      const issue = await inspectPngEvidence(paths.candidateRoot, ref);
      if (issue) errors.push(`atlas.md screenshot ${ref} ${issue}`);
    }
  }

  const generatedAt = manifest?.generatedAt ? Date.parse(manifest.generatedAt) : NaN;
  if (manifest && !Number.isFinite(generatedAt)) errors.push('manifest.json generatedAt must be an ISO timestamp');

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    surfaceCount,
    entityCount,
    verifiedSurfaceCount,
    generatedAt: Number.isFinite(generatedAt) ? generatedAt : undefined,
  };
}

async function copyCurrentIntoHistory(canonicalRoot: string, candidateRoot: string): Promise<void> {
  if (!existsSync(canonicalRoot)) return;
  const historyRoot = join(candidateRoot, '.history');
  const oldHistory = join(canonicalRoot, '.history');
  if (existsSync(oldHistory)) await cp(oldHistory, historyRoot, { recursive: true, force: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotRoot = join(historyRoot, stamp);
  await mkdir(snapshotRoot, { recursive: true });
  for (const name of ['atlas.md', 'atlas.json', 'manifest.json', 'checkpoint.json', 'changelog.md', 'README.md', 'shots']) {
    const source = join(canonicalRoot, name);
    if (!existsSync(source)) continue;
    await cp(source, join(snapshotRoot, name), { recursive: true, force: true });
  }
}

async function removeGeneratedAtlasDirectory(
  projectRoot: string,
  allowedRoot: string,
  targetPath: string,
  reason: string,
): Promise<void> {
  await safeRemoveTree({
    targetPath,
    allowedRoot,
    reason,
    mode: 'delete',
    permanent: true,
    allowNonEmpty: true,
    allowedTopLevelNames: ATLAS_BUNDLE_TOP_LEVEL_NAMES,
    maxEntries: ATLAS_CLEANUP_MAX_ENTRIES,
    protectedPaths: [projectRoot],
  });
}

async function moveGeneratedAtlasDirectory(
  projectRoot: string,
  docsRoot: string,
  sourcePath: string,
  destinationPath: string,
  reason: string,
): Promise<void> {
  await safeMoveDirectory({
    targetPath: sourcePath,
    destinationPath,
    allowedRoot: docsRoot,
    reason,
    allowNonEmpty: true,
    allowedTopLevelNames: ATLAS_BUNDLE_TOP_LEVEL_NAMES,
    maxEntries: ATLAS_CLEANUP_MAX_ENTRIES,
    protectedPaths: [projectRoot],
  });
}

/** Validate first, then swap whole directories with an automatic rollback. */
export async function promoteAtlasCandidate(projectRoot: string, runId: string): Promise<AtlasValidationResult> {
  const validation = await validateAtlasCandidate(projectRoot, runId);
  if (!validation.valid) throw new Error(`Atlas candidate failed validation:\n- ${validation.errors.join('\n- ')}`);

  const paths = atlasCandidatePaths(projectRoot, runId);
  await mkdir(paths.docsRoot, { recursive: true });

  const rollbackRoot = join(paths.docsRoot, `.ui-atlas-rollback-${runId}`);
  const publishRoot = join(paths.docsRoot, `.ui-atlas-publish-${runId}`);
  assertInside(paths.docsRoot, rollbackRoot, 'Atlas rollback');
  assertInside(paths.docsRoot, publishRoot, 'Atlas publication staging');

  // Recover an interrupted prior promotion before touching the last-good Atlas.
  if (existsSync(rollbackRoot) && !existsSync(paths.canonicalRoot)) {
    await moveGeneratedAtlasDirectory(
      paths.projectRoot,
      paths.docsRoot,
      rollbackRoot,
      paths.canonicalRoot,
      'Recover the last-good Atlas after an interrupted publication',
    );
  }

  // If the canonical bundle already carries this run ID, publication succeeded
  // before a crash/restart. Treat the operation as idempotently complete.
  if (existsSync(paths.canonicalRoot)) {
    try {
      const currentManifest = JSON.parse(await readFile(join(paths.canonicalRoot, 'manifest.json'), 'utf8')) as AtlasManifest;
      if (currentManifest.runId === runId && currentManifest.status === 'complete') {
        if (existsSync(rollbackRoot)) {
          await removeGeneratedAtlasDirectory(
            paths.projectRoot,
            paths.docsRoot,
            rollbackRoot,
            'Remove generated Atlas rollback staging after an idempotent publication retry',
          ).catch(() => {});
        }
        if (existsSync(publishRoot)) {
          await removeGeneratedAtlasDirectory(
            paths.projectRoot,
            paths.docsRoot,
            publishRoot,
            'Remove generated Atlas publication staging after an idempotent publication retry',
          ).catch(() => {});
        }
        return validation;
      }
    } catch {}
  }

  if (existsSync(rollbackRoot)) {
    await removeGeneratedAtlasDirectory(
      paths.projectRoot,
      paths.docsRoot,
      rollbackRoot,
      'Remove stale generated Atlas rollback staging before publication',
    );
  }
  if (existsSync(publishRoot)) {
    await removeGeneratedAtlasDirectory(
      paths.projectRoot,
      paths.docsRoot,
      publishRoot,
      'Remove stale generated Atlas publication staging before publication',
    );
  }
  await copyCurrentIntoHistory(paths.canonicalRoot, paths.candidateRoot);
  await cp(paths.candidateRoot, publishRoot, { recursive: true, force: true });

  const hadCurrent = existsSync(paths.canonicalRoot);
  if (hadCurrent) {
    await moveGeneratedAtlasDirectory(
      paths.projectRoot,
      paths.docsRoot,
      paths.canonicalRoot,
      rollbackRoot,
      'Move the last-good Atlas into rollback staging before publication',
    );
  }
  try {
    await moveGeneratedAtlasDirectory(
      paths.projectRoot,
      paths.docsRoot,
      publishRoot,
      paths.canonicalRoot,
      'Atomically publish the validated generated Atlas bundle',
    );
  } catch (error) {
    if (hadCurrent && existsSync(rollbackRoot) && !existsSync(paths.canonicalRoot)) {
      await moveGeneratedAtlasDirectory(
        paths.projectRoot,
        paths.docsRoot,
        rollbackRoot,
        paths.canonicalRoot,
        'Restore the last-good Atlas after publication failed',
      ).catch(() => {});
    }
    throw error;
  }

  // Publication is already successful. Cleanup is best-effort and must never
  // convert a published run into a reported failure.
  if (existsSync(rollbackRoot)) {
    await removeGeneratedAtlasDirectory(
      paths.projectRoot,
      paths.docsRoot,
      rollbackRoot,
      'Remove generated Atlas rollback staging after successful publication',
    ).catch(() => {});
  }
  return validation;
}

export async function discardAtlasCandidate(projectRoot: string, runId: string): Promise<void> {
  const paths = atlasCandidatePaths(projectRoot, runId);
  assertInside(paths.candidatesRoot, paths.candidateRoot, 'Atlas candidate');
  if (existsSync(paths.candidateRoot)) {
    await removeGeneratedAtlasDirectory(
      paths.projectRoot,
      paths.candidatesRoot,
      paths.candidateRoot,
      'Discard the generated Atlas candidate requested by Agent Forge',
    );
  }
  try {
    const remaining = await readdir(paths.candidatesRoot);
    if (remaining.length === 0) {
      await safeRemoveTree({
        targetPath: paths.candidatesRoot,
        allowedRoot: paths.docsRoot,
        reason: 'Remove the empty generated Atlas candidate container',
        mode: 'delete',
        permanent: true,
        protectedPaths: [paths.projectRoot],
      });
    }
  } catch {}
}
