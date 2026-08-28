import { createHash, randomUUID } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'fs';
import { appendFile } from 'fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import type { PersistedData } from '../../shared/protocol';
import { getArtifactRoot } from './artifact-paths';

export type ArtifactType =
  | 'chat-upload-original'
  | 'qa-screenshot'
  | 'qa-run-report'
  | 'browser-temporary'
  | 'ui-atlas-current'
  | 'ui-atlas-history'
  | 'ui-atlas-candidate'
  | 'persistence-backup'
  | 'support-bundle'
  | 'other-owned-temporary'
  | 'unknown';

export type ArtifactLifecycle = 'reserved' | 'committed' | 'unreferenced' | 'leased';

export interface ArtifactOwnerRef {
  kind: 'message' | 'qa-evidence' | 'atlas-run' | 'lease' | 'created-manifest';
  id?: string;
}

export interface ArtifactRecord {
  schemaVersion: 1;
  artifactId: string;
  type: ArtifactType;
  relativePath: string;
  byteSize: number;
  createdAt: string;
  lifecycle: ArtifactLifecycle;
  ownerRefs: ArtifactOwnerRef[];
}

export interface ArtifactInventoryReport {
  inventoryId: string;
  generatedAt: string;
  artifactRoot: string;
  scannedSources: string[];
  totals: { files: number; bytes: number };
  byType: Record<ArtifactType, { files: number; bytes: number; referenced: number; unreferenced: number }>;
  byLifecycle: Record<ArtifactLifecycle, number>;
  referenced: number;
  unreferenced: number;
  unknown: number;
  malformed: number;
  outsideRoot: number;
  oldestUnreferencedAt?: string;
  newestUnreferencedAt?: string;
  proposedQuarantine: Array<{ relativePath: string; reason: string; type: ArtifactType; byteSize: number }>;
  activeLeases: number;
}

const INVENTORY_DIR = 'inventory';
const CREATED_LOG = 'created.jsonl';
const MAX_WALK_FILES = 20_000;

function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function classifyArtifactRelativePath(relativePath: string): ArtifactType {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return 'unknown';
  if (normalized.startsWith('chat-images/')) return 'chat-upload-original';
  if (normalized.startsWith('qa/') && normalized.endsWith('.png')) return 'qa-screenshot';
  if (normalized.startsWith('qa/') && /\.(md|json|html)$/i.test(normalized)) return 'qa-run-report';
  if (normalized.startsWith('qa/')) return 'qa-screenshot';
  if (normalized.startsWith('atlas-queries/')) return 'other-owned-temporary';
  if (normalized.includes('/.history/') || normalized.startsWith('ui-atlas/history/')) return 'ui-atlas-history';
  if (normalized.includes('atlas-candidates') || normalized.startsWith('ui-atlas/candidates/')) return 'ui-atlas-candidate';
  if (normalized.endsWith('atlas.json') || normalized.endsWith('current.json')) return 'ui-atlas-current';
  if (normalized.startsWith('browser/') || normalized.includes('playwright')) return 'browser-temporary';
  if (/data\.json\.|pids\.json\.|agent-forge\.lock\./.test(normalized)) return 'persistence-backup';
  if (normalized.startsWith('support/')) return 'support-bundle';
  return 'unknown';
}

export function collectArtifactReferences(data: Partial<PersistedData> | null | undefined, extra: string[] = []): string[] {
  const refs = new Set<string>(extra.filter(path => typeof path === 'string' && path));
  for (const message of data?.messages ?? []) {
    for (const attachment of message.imageAttachments ?? []) {
      if (typeof attachment.path === 'string' && attachment.path) refs.add(attachment.path);
    }
  }
  for (const workspace of data?.workspaces ?? []) {
    for (const run of workspace.qaRuns ?? []) {
      for (const evidence of run.evidence ?? []) {
        if (evidence.kind === 'screenshot' && evidence.ref) refs.add(evidence.ref);
      }
    }
    if (workspace.atlasRun?.candidateRelPath) refs.add(workspace.atlasRun.candidateRelPath);
  }
  return [...refs];
}

function emptyTypeCounts(): ArtifactInventoryReport['byType'] {
  const types: ArtifactType[] = [
    'chat-upload-original', 'qa-screenshot', 'qa-run-report', 'browser-temporary',
    'ui-atlas-current', 'ui-atlas-history', 'ui-atlas-candidate', 'persistence-backup',
    'support-bundle', 'other-owned-temporary', 'unknown',
  ];
  return Object.fromEntries(types.map(type => [type, { files: 0, bytes: 0, referenced: 0, unreferenced: 0 }])) as ArtifactInventoryReport['byType'];
}

function walkFiles(root: string): { files: string[]; malformed: number } {
  const files: string[] = [];
  let malformed = 0;
  const visit = (directory: string) => {
    if (files.length >= MAX_WALK_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      malformed += 1;
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_WALK_FILES) return;
      const full = join(directory, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        malformed += 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        malformed += 1;
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === INVENTORY_DIR) continue;
        visit(full);
        continue;
      }
      if (stat.isFile()) files.push(full);
      else malformed += 1;
    }
  };
  if (existsSync(root)) visit(root);
  return { files, malformed };
}

export function createdArtifactLogPath(artifactRoot = getArtifactRoot()): string {
  return join(artifactRoot, INVENTORY_DIR, CREATED_LOG);
}

export async function recordCreatedArtifact(input: {
  type: ArtifactType;
  absolutePath: string;
  byteSize: number;
  artifactRoot?: string;
  ownerRefs?: ArtifactOwnerRef[];
}): Promise<ArtifactRecord | null> {
  const artifactRoot = resolve(input.artifactRoot ?? getArtifactRoot());
  const absolutePath = resolve(input.absolutePath);
  if (!isPathInside(artifactRoot, absolutePath)) return null;
  const record: ArtifactRecord = {
    schemaVersion: 1,
    artifactId: randomUUID(),
    type: input.type,
    relativePath: relative(artifactRoot, absolutePath).replace(/\\/g, '/'),
    byteSize: input.byteSize,
    createdAt: new Date().toISOString(),
    lifecycle: 'committed',
    ownerRefs: input.ownerRefs ?? [],
  };
  const logPath = createdArtifactLogPath(artifactRoot);
  mkdirSync(join(artifactRoot, INVENTORY_DIR), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function buildArtifactInventory(options: {
  artifactRoot?: string;
  references?: string[];
  leases?: string[];
  persisted?: Partial<PersistedData> | null;
  now?: () => number;
}): Promise<ArtifactInventoryReport> {
  const artifactRoot = resolve(options.artifactRoot ?? getArtifactRoot());
  const references = collectArtifactReferences(options.persisted, options.references);
  const leases = new Set((options.leases ?? []).map(path => resolve(path)));
  const resolvedRefs = new Set<string>();
  let outsideRoot = 0;
  for (const ref of references) {
    const candidate = isAbsolute(ref) ? resolve(ref) : resolve(artifactRoot, ref);
    if (!isPathInside(artifactRoot, candidate)) {
      outsideRoot += 1;
      continue;
    }
    resolvedRefs.add(candidate);
  }

  const { files, malformed } = walkFiles(artifactRoot);
  const byType = emptyTypeCounts();
  const byLifecycle: Record<ArtifactLifecycle, number> = { reserved: 0, committed: 0, unreferenced: 0, leased: 0 };
  const proposedQuarantine: ArtifactInventoryReport['proposedQuarantine'] = [];
  let totalsBytes = 0;
  let referenced = 0;
  let unreferenced = 0;
  let unknown = 0;
  let oldestUnreferencedAt: number | undefined;
  let newestUnreferencedAt: number | undefined;

  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const relativePath = relative(artifactRoot, file).replace(/\\/g, '/');
    const type = classifyArtifactRelativePath(relativePath);
    const leased = leases.has(resolve(file));
    const isReferenced = resolvedRefs.has(resolve(file)) || leased;
    const lifecycle: ArtifactLifecycle = leased ? 'leased' : resolvedRefs.has(resolve(file)) ? 'committed' : 'unreferenced';
    byType[type].files += 1;
    byType[type].bytes += stat.size;
    if (isReferenced) byType[type].referenced += 1;
    else byType[type].unreferenced += 1;
    byLifecycle[lifecycle] += 1;
    totalsBytes += stat.size;
    if (type === 'unknown') unknown += 1;
    if (lifecycle === 'unreferenced') {
      unreferenced += 1;
      const mtime = stat.mtimeMs;
      oldestUnreferencedAt = oldestUnreferencedAt === undefined ? mtime : Math.min(oldestUnreferencedAt, mtime);
      newestUnreferencedAt = newestUnreferencedAt === undefined ? mtime : Math.max(newestUnreferencedAt, mtime);
      proposedQuarantine.push({
        relativePath,
        reason: 'unreferenced',
        type,
        byteSize: stat.size,
      });
    } else {
      referenced += 1;
    }
  }

  const generatedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const inventoryId = createHash('sha256')
    .update(JSON.stringify({
      artifactRoot,
      files: files.map(file => relative(artifactRoot, file).replace(/\\/g, '/')).sort(),
      referenced: [...resolvedRefs].map(path => relative(artifactRoot, path).replace(/\\/g, '/')).sort(),
      generatedAt,
    }))
    .digest('hex')
    .slice(0, 24);

  return {
    inventoryId,
    generatedAt,
    artifactRoot,
    scannedSources: ['artifact-root', 'persisted-messages', 'qa-evidence', 'atlas-run', 'leases'],
    totals: { files: files.length, bytes: totalsBytes },
    byType,
    byLifecycle,
    referenced,
    unreferenced,
    unknown,
    malformed,
    outsideRoot,
    oldestUnreferencedAt: oldestUnreferencedAt === undefined ? undefined : new Date(oldestUnreferencedAt).toISOString(),
    newestUnreferencedAt: newestUnreferencedAt === undefined ? undefined : new Date(newestUnreferencedAt).toISOString(),
    proposedQuarantine,
    activeLeases: leases.size,
  };
}
