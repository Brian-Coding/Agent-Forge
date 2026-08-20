// @ts-check

import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export const SAFE_FILESYSTEM_DRY_RUN_ENV = 'AGENT_FORGE_SAFE_FS_DRY_RUN';

const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_CONFIGURED_ENTRIES = 2_000_000;
const PROTECTED_ENVIRONMENT_KEYS = [
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'SYSTEMROOT',
  'WINDIR',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'APPDATA',
  'LOCALAPPDATA',
];

/**
 * @typedef {'allow' | 'deny' | 'complete' | 'dry-run' | 'noop'} SafeFilesystemDecision
 *
 * @typedef {object} SafeFilesystemAuditEvent
 * @property {string} at
 * @property {string} command
 * @property {SafeFilesystemDecision} decision
 * @property {string} reason
 * @property {string=} target
 * @property {string=} resolvedTarget
 * @property {string=} allowedRoot
 * @property {string=} destination
 * @property {number=} entryCount
 * @property {string=} code
 * @property {string=} detail
 *
 * @typedef {object} AuditOptions
 * @property {false | ((event: SafeFilesystemAuditEvent) => void)=} audit
 *
 * @typedef {AuditOptions & {
 *   targetPath: string,
 *   allowedRoot: string,
 *   reason: string,
 *   allowNonEmpty?: boolean,
 *   allowedTopLevelNames?: readonly string[],
 *   maxEntries?: number,
 *   expectedTargetName?: string | RegExp,
 *   protectedPaths?: readonly string[],
 *   dryRun?: boolean,
 * }} PathPolicyOptions
 *
 * @typedef {PathPolicyOptions & {
 *   mode?: 'delete' | 'quarantine',
 *   permanent?: boolean,
 *   quarantineRoot?: string,
 * }} RemoveOptions
 *
 * @typedef {AuditOptions & {
 *   prefix: string,
 *   baseDirectory?: string,
 *   approvedBaseDirectories?: readonly string[],
 *   protectedPaths?: readonly string[],
 * }} FreshTempOptions
 *
 * @typedef {PathPolicyOptions & {
 *   destinationPath: string,
 *   expectedDestinationName?: string | RegExp,
 * }} MoveDirectoryOptions
 */

export class SafeFilesystemPolicyError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SafeFilesystemPolicyError';
    this.code = code;
  }
}

/** @param {unknown} error */
function errorCode(error) {
  return error instanceof SafeFilesystemPolicyError
    ? error.code
    : (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'FILESYSTEM_ERROR');
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {AuditOptions | undefined} options @param {Omit<SafeFilesystemAuditEvent, 'at'>} event */
function emitAudit(options, event) {
  const completeEvent = { at: new Date().toISOString(), ...event };
  if (options?.audit === false) return;
  if (typeof options?.audit === 'function') {
    try { options.audit(completeEvent); } catch {}
    return;
  }
  console.info(`[safe-filesystem] ${JSON.stringify(completeEvent)}`);
}

/** @param {string} value */
function comparisonPath(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** @param {string} first @param {string} second */
function samePath(first, second) {
  return comparisonPath(first) === comparisonPath(second);
}

/** @param {string} root @param {string} target */
function strictlyInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** @param {string} value */
function bestEffortRealpathSync(value) {
  const resolved = resolve(value);
  try { return realpathSync(resolved); } catch { return resolved; }
}

/** @param {readonly string[] | undefined} extraPaths */
function collectProtectedPaths(extraPaths) {
  /** @type {string[]} */
  const candidates = [homedir(), process.cwd(), ...(extraPaths ?? [])];
  const normalizedEnvironment = new Map(
    Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]),
  );
  for (const key of PROTECTED_ENVIRONMENT_KEYS) {
    const value = normalizedEnvironment.get(key);
    if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
  }
  const homeDrive = normalizedEnvironment.get('HOMEDRIVE');
  const homePath = normalizedEnvironment.get('HOMEPATH');
  if (homeDrive && homePath) candidates.push(`${homeDrive}${homePath}`);

  const unique = new Map();
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    const canonical = bestEffortRealpathSync(candidate);
    unique.set(comparisonPath(canonical), canonical);
  }
  return [...unique.values()];
}

/** @param {string} value @param {string} label */
function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new SafeFilesystemPolicyError('AMBIGUOUS_PATH', `${label} must be a non-empty absolute path`);
  }
  return resolve(value);
}

/** @param {string} reason */
function requireReason(reason) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) {
    throw new SafeFilesystemPolicyError('INVALID_REASON', 'A concise cleanup reason is required');
  }
  return reason.trim();
}

/** @param {string} path @param {string} label @param {string} missingCode */
async function requiredLstat(path, label, missingCode) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new SafeFilesystemPolicyError(missingCode, `${label} does not exist: ${path}`);
    }
    throw error;
  }
}

/** @param {string} allowedRoot @param {readonly string[]} protectedPaths */
function assertAllowedRootIsNarrow(allowedRoot, protectedPaths) {
  if (samePath(allowedRoot, parse(allowedRoot).root)) {
    throw new SafeFilesystemPolicyError('BROAD_ALLOWED_ROOT', 'The filesystem root cannot be an allowed cleanup root');
  }
  for (const protectedPath of protectedPaths) {
    if (samePath(allowedRoot, protectedPath) || strictlyInside(allowedRoot, protectedPath)) {
      throw new SafeFilesystemPolicyError(
        'BROAD_ALLOWED_ROOT',
        `The allowed cleanup root is broad enough to contain a protected path: ${allowedRoot}`,
      );
    }
  }
}

/** @param {string} target @param {readonly string[]} protectedPaths */
function assertTargetDoesNotContainProtectedPath(target, protectedPaths) {
  if (samePath(target, parse(target).root)) {
    throw new SafeFilesystemPolicyError('PROTECTED_TARGET', 'Refusing to operate on a filesystem root');
  }
  for (const protectedPath of protectedPaths) {
    if (samePath(target, protectedPath) || strictlyInside(target, protectedPath)) {
      throw new SafeFilesystemPolicyError(
        'PROTECTED_TARGET',
        `Refusing to operate on a protected path or one of its ancestors: ${target}`,
      );
    }
  }
}

/** @param {string} actualName @param {string | RegExp | undefined} expected @param {string} code */
function assertExpectedName(actualName, expected, code) {
  if (expected === undefined) return;
  if (typeof expected === 'string') {
    if (actualName !== expected) {
      throw new SafeFilesystemPolicyError(code, `Unexpected target name: ${actualName}`);
    }
    return;
  }
  expected.lastIndex = 0;
  if (!expected.test(actualName)) {
    throw new SafeFilesystemPolicyError(code, `Unexpected target name: ${actualName}`);
  }
}

/** @param {string} rootPath @param {string} targetPath */
async function assertPathComponentsAreNotLinks(rootPath, targetPath) {
  const rel = relative(rootPath, targetPath);
  let current = rootPath;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await requiredLstat(current, 'Path component', 'MISSING_TARGET');
    if (info.isSymbolicLink()) {
      throw new SafeFilesystemPolicyError('SYMLINK_OR_JUNCTION', `Refusing a symlink or junction path: ${current}`);
    }
  }
}

/** @param {string} root @param {number} maxEntries */
async function inspectDirectoryTree(root, maxEntries) {
  let entryCount = 0;
  /** @type {string[]} */
  const topLevelNames = [];
  const pending = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const entries = await readdir(current.path, { withFileTypes: true });
    for (const entry of entries) {
      entryCount++;
      if (entryCount > maxEntries) {
        throw new SafeFilesystemPolicyError(
          'ENTRY_LIMIT_EXCEEDED',
          `Cleanup target exceeds the ${maxEntries}-entry inspection limit`,
        );
      }
      if (current.depth === 0) topLevelNames.push(entry.name);
      const child = join(current.path, entry.name);
      const info = await requiredLstat(child, 'Cleanup entry', 'TARGET_CHANGED');
      if (info.isSymbolicLink()) {
        throw new SafeFilesystemPolicyError('SYMLINK_OR_JUNCTION', `Cleanup tree contains a symlink or junction: ${child}`);
      }
      if (info.isDirectory()) pending.push({ path: child, depth: current.depth + 1 });
      else if (!info.isFile()) {
        throw new SafeFilesystemPolicyError('SPECIAL_FILE', `Cleanup tree contains a special filesystem entry: ${child}`);
      }
    }
  }
  return { entryCount, topLevelNames };
}

/** @param {number | undefined} configured */
function validatedMaxEntries(configured) {
  const value = configured ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONFIGURED_ENTRIES) {
    throw new SafeFilesystemPolicyError(
      'INVALID_ENTRY_LIMIT',
      `maxEntries must be an integer from 1 through ${MAX_CONFIGURED_ENTRIES}`,
    );
  }
  return value;
}

/** @param {boolean | undefined} configured */
function dryRunEnabled(configured) {
  return configured ?? process.env[SAFE_FILESYSTEM_DRY_RUN_ENV] === '1';
}

/**
 * Validate a freshly-created temporary base. The base must be explicitly
 * approved and must never be a home/config/system/workspace root.
 *
 * @param {string} baseDirectory
 * @param {{ approvedBaseDirectories?: readonly string[], protectedPaths?: readonly string[] }=} options
 */
export function assertSafeTemporaryBase(baseDirectory, options = {}) {
  const candidate = requireAbsolute(baseDirectory, 'Temporary base');
  let info;
  try { info = lstatSync(candidate); }
  catch (error) {
    throw new SafeFilesystemPolicyError('MISSING_TEMP_BASE', `Temporary base does not exist: ${candidate}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SafeFilesystemPolicyError('UNSAFE_TEMP_BASE', 'Temporary base must be a real directory, not a symlink or junction');
  }
  const canonical = realpathSync(candidate);
  if (samePath(canonical, parse(canonical).root)) {
    throw new SafeFilesystemPolicyError('UNSAFE_TEMP_BASE', 'A filesystem root cannot be used for temporary work');
  }
  for (const protectedPath of collectProtectedPaths(options.protectedPaths)) {
    if (samePath(canonical, protectedPath)) {
      throw new SafeFilesystemPolicyError('UNSAFE_TEMP_BASE', 'A protected system or workspace path cannot be used for temporary work');
    }
  }

  const approved = options.approvedBaseDirectories ?? [tmpdir()];
  const approvedCanonical = approved
    .filter(value => typeof value === 'string' && isAbsolute(value))
    .map(bestEffortRealpathSync);
  if (!approvedCanonical.some(path => samePath(path, canonical))) {
    throw new SafeFilesystemPolicyError('UNAPPROVED_TEMP_BASE', 'Temporary base is not explicitly approved');
  }
  return canonical;
}

/** @param {FreshTempOptions} options */
export function createFreshTempDirectorySync(options) {
  const command = 'filesystem.create-fresh-temp-directory';
  const target = options?.baseDirectory ?? tmpdir();
  const reason = 'Create isolated temporary workspace';
  try {
    if (!options || typeof options.prefix !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}-$/.test(options.prefix)) {
      throw new SafeFilesystemPolicyError(
        'INVALID_TEMP_PREFIX',
        'Temporary directory prefix must be a bounded filename ending in a dash',
      );
    }
    const base = assertSafeTemporaryBase(target, {
      approvedBaseDirectories: options.approvedBaseDirectories,
      protectedPaths: options.protectedPaths,
    });
    const created = realpathSync(mkdtempSync(join(base, options.prefix)));
    if (!strictlyInside(base, created)) {
      throw new SafeFilesystemPolicyError('TEMP_DIRECTORY_ESCAPE', 'Fresh temporary directory escaped its approved base');
    }
    emitAudit(options, {
      command,
      decision: 'complete',
      reason,
      target,
      resolvedTarget: created,
      allowedRoot: base,
    });
    return created;
  } catch (error) {
    emitAudit(options, {
      command,
      decision: 'deny',
      reason,
      target,
      code: errorCode(error),
      detail: errorMessage(error),
    });
    throw error;
  }
}

/**
 * @param {PathPolicyOptions} options
 * @param {'directory' | 'file'} kind
 * @param {string} command
 */
async function preflightPath(options, kind, command) {
  const targetForAudit = typeof options?.targetPath === 'string' ? options.targetPath : undefined;
  let reason = typeof options?.reason === 'string' ? options.reason : 'Unspecified filesystem operation';
  try {
    reason = requireReason(options?.reason);
    const lexicalRoot = requireAbsolute(options?.allowedRoot, 'Allowed root');
    const lexicalTarget = requireAbsolute(options?.targetPath, 'Target');
    if (!strictlyInside(lexicalRoot, lexicalTarget)) {
      throw new SafeFilesystemPolicyError('OUTSIDE_ALLOWED_ROOT', 'Target must be strictly inside its allowed root');
    }

    const rootInfo = await requiredLstat(lexicalRoot, 'Allowed root', 'MISSING_ALLOWED_ROOT');
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new SafeFilesystemPolicyError('UNSAFE_ALLOWED_ROOT', 'Allowed root must be a real directory');
    }
    const resolvedRoot = await realpath(lexicalRoot);
    const protectedPaths = collectProtectedPaths(options.protectedPaths);
    assertAllowedRootIsNarrow(resolvedRoot, protectedPaths);

    const targetInfo = await requiredLstat(lexicalTarget, 'Target', 'MISSING_TARGET');
    if (targetInfo.isSymbolicLink()) {
      throw new SafeFilesystemPolicyError('SYMLINK_OR_JUNCTION', 'Target is a symlink or junction');
    }
    await assertPathComponentsAreNotLinks(lexicalRoot, lexicalTarget);
    const resolvedTarget = await realpath(lexicalTarget);
    if (!strictlyInside(resolvedRoot, resolvedTarget)) {
      throw new SafeFilesystemPolicyError('REALPATH_ESCAPE', 'Resolved target escaped its allowed root');
    }
    assertTargetDoesNotContainProtectedPath(resolvedTarget, protectedPaths);
    assertExpectedName(basename(resolvedTarget), options.expectedTargetName, 'UNEXPECTED_TARGET_NAME');

    if (kind === 'directory' && !targetInfo.isDirectory()) {
      throw new SafeFilesystemPolicyError('WRONG_TARGET_KIND', 'Expected a directory cleanup target');
    }
    if (kind === 'file' && !targetInfo.isFile()) {
      throw new SafeFilesystemPolicyError('WRONG_TARGET_KIND', 'Expected a regular file cleanup target');
    }

    let entryCount;
    if (kind === 'directory') {
      const inspected = await inspectDirectoryTree(resolvedTarget, validatedMaxEntries(options.maxEntries));
      entryCount = inspected.entryCount;
      if (entryCount > 0 && options.allowNonEmpty !== true) {
        throw new SafeFilesystemPolicyError(
          'UNEXPECTED_CONTENTS',
          'Refusing to remove a populated directory without explicit acknowledgement',
        );
      }
      if (options.allowedTopLevelNames) {
        const allowedNames = new Set(options.allowedTopLevelNames);
        const unexpected = inspected.topLevelNames.filter(name => !allowedNames.has(name));
        if (unexpected.length > 0) {
          throw new SafeFilesystemPolicyError(
            'UNEXPECTED_CONTENTS',
            `Cleanup target has unexpected top-level entries: ${unexpected.slice(0, 5).join(', ')}`,
          );
        }
      }
    }

    const dryRun = dryRunEnabled(options.dryRun);
    const result = {
      lexicalRoot,
      lexicalTarget,
      resolvedRoot,
      resolvedTarget,
      targetIdentity: { dev: targetInfo.dev, ino: targetInfo.ino, mode: targetInfo.mode },
      entryCount,
      dryRun,
      reason,
    };
    emitAudit(options, {
      command,
      decision: dryRun ? 'dry-run' : 'allow',
      reason,
      target: lexicalTarget,
      resolvedTarget,
      allowedRoot: resolvedRoot,
      entryCount,
    });
    return result;
  } catch (error) {
    emitAudit(options, {
      command,
      decision: 'deny',
      reason,
      target: targetForAudit,
      code: errorCode(error),
      detail: errorMessage(error),
    });
    throw error;
  }
}

/** @param {Awaited<ReturnType<typeof preflightPath>>} preflight */
async function assertTargetUnchanged(preflight) {
  const current = await requiredLstat(preflight.resolvedTarget, 'Target', 'TARGET_CHANGED');
  if (current.isSymbolicLink()
    || current.dev !== preflight.targetIdentity.dev
    || current.ino !== preflight.targetIdentity.ino
    || current.mode !== preflight.targetIdentity.mode) {
    throw new SafeFilesystemPolicyError('TARGET_CHANGED', 'Target changed after preflight inspection');
  }
  const currentRealpath = await realpath(preflight.resolvedTarget);
  if (!samePath(currentRealpath, preflight.resolvedTarget)) {
    throw new SafeFilesystemPolicyError('TARGET_CHANGED', 'Target resolved path changed after preflight inspection');
  }
}

/**
 * @param {Awaited<ReturnType<typeof preflightPath>>} preflight
 * @param {RemoveOptions} options
 */
async function prepareQuarantineDestination(preflight, options) {
  const lexicalQuarantine = requireAbsolute(
    options.quarantineRoot ?? join(preflight.resolvedRoot, '.agent-forge-quarantine'),
    'Quarantine root',
  );
  if (!strictlyInside(preflight.resolvedRoot, lexicalQuarantine)) {
    throw new SafeFilesystemPolicyError('UNSAFE_QUARANTINE_ROOT', 'Quarantine root must be inside the allowed root');
  }
  if (samePath(preflight.resolvedTarget, lexicalQuarantine)
    || strictlyInside(preflight.resolvedTarget, lexicalQuarantine)) {
    throw new SafeFilesystemPolicyError('UNSAFE_QUARANTINE_ROOT', 'Quarantine root cannot be the target or live inside it');
  }

  try {
    await mkdir(lexicalQuarantine, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const quarantineInfo = await requiredLstat(lexicalQuarantine, 'Quarantine root', 'MISSING_QUARANTINE_ROOT');
  if (quarantineInfo.isSymbolicLink() || !quarantineInfo.isDirectory()) {
    throw new SafeFilesystemPolicyError('UNSAFE_QUARANTINE_ROOT', 'Quarantine root must be a real directory');
  }
  const resolvedQuarantine = await realpath(lexicalQuarantine);
  if (!strictlyInside(preflight.resolvedRoot, resolvedQuarantine)) {
    throw new SafeFilesystemPolicyError('UNSAFE_QUARANTINE_ROOT', 'Resolved quarantine root escaped the allowed root');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = join(resolvedQuarantine, `${basename(preflight.resolvedTarget)}-${stamp}-${randomUUID()}`);
  try {
    await lstat(destination);
    throw new SafeFilesystemPolicyError('DESTINATION_EXISTS', `Quarantine destination already exists: ${destination}`);
  } catch (error) {
    if (error instanceof SafeFilesystemPolicyError) throw error;
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return destination;
}

/** @param {RemoveOptions} options @param {'directory' | 'file'} kind */
async function safeRemove(options, kind) {
  const command = kind === 'directory' ? 'filesystem.remove-tree' : 'filesystem.remove-file';
  const mode = options?.mode ?? 'quarantine';
  let preflight;
  try {
    if (mode !== 'delete' && mode !== 'quarantine') {
      throw new SafeFilesystemPolicyError('INVALID_REMOVAL_MODE', 'Removal mode must be delete or quarantine');
    }
    if (mode === 'delete' && options?.permanent !== true) {
      throw new SafeFilesystemPolicyError(
        'PERMANENT_DELETE_NOT_ACKNOWLEDGED',
        'Permanent deletion requires permanent: true; quarantine is the default',
      );
    }
    preflight = await preflightPath(options, kind, command);
    if (preflight.dryRun) {
      return { status: 'dry-run', path: preflight.resolvedTarget, entryCount: preflight.entryCount };
    }
    await assertTargetUnchanged(preflight);
    if (mode === 'quarantine') {
      const destination = await prepareQuarantineDestination(preflight, options);
      await assertTargetUnchanged(preflight);
      await rename(preflight.resolvedTarget, destination);
      emitAudit(options, {
        command,
        decision: 'complete',
        reason: preflight.reason,
        target: preflight.lexicalTarget,
        resolvedTarget: preflight.resolvedTarget,
        allowedRoot: preflight.resolvedRoot,
        destination,
        entryCount: preflight.entryCount,
      });
      return { status: 'quarantined', path: destination, entryCount: preflight.entryCount };
    }

    if (kind === 'directory') {
      await rm(preflight.resolvedTarget, { recursive: true, force: false, maxRetries: 2 });
    } else {
      await unlink(preflight.resolvedTarget);
    }
    emitAudit(options, {
      command,
      decision: 'complete',
      reason: preflight.reason,
      target: preflight.lexicalTarget,
      resolvedTarget: preflight.resolvedTarget,
      allowedRoot: preflight.resolvedRoot,
      entryCount: preflight.entryCount,
    });
    return { status: 'deleted', path: preflight.resolvedTarget, entryCount: preflight.entryCount };
  } catch (error) {
    if (preflight) {
      emitAudit(options, {
        command,
        decision: 'deny',
        reason: preflight.reason,
        target: preflight.lexicalTarget,
        resolvedTarget: preflight.resolvedTarget,
        allowedRoot: preflight.resolvedRoot,
        entryCount: preflight.entryCount,
        code: errorCode(error),
        detail: errorMessage(error),
      });
    } else if (error instanceof SafeFilesystemPolicyError
      && (error.code === 'INVALID_REMOVAL_MODE' || error.code === 'PERMANENT_DELETE_NOT_ACKNOWLEDGED')) {
      emitAudit(options, {
        command,
        decision: 'deny',
        reason: typeof options?.reason === 'string' ? options.reason : 'Unspecified filesystem operation',
        target: typeof options?.targetPath === 'string' ? options.targetPath : undefined,
        code: error.code,
        detail: error.message,
      });
    }
    throw error;
  }
}

/** @param {RemoveOptions} options */
export function safeRemoveTree(options) {
  return safeRemove(options, 'directory');
}

/** @param {RemoveOptions} options */
export function safeRemoveFile(options) {
  return safeRemove(options, 'file');
}

/** @param {string} root @param {string} destination */
async function assertSafeMoveDestination(root, destination) {
  if (!strictlyInside(root, destination)) {
    throw new SafeFilesystemPolicyError('OUTSIDE_ALLOWED_ROOT', 'Move destination must stay inside the allowed root');
  }
  try {
    await lstat(destination);
    throw new SafeFilesystemPolicyError('DESTINATION_EXISTS', `Move destination already exists: ${destination}`);
  } catch (error) {
    if (error instanceof SafeFilesystemPolicyError) throw error;
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const parent = dirname(destination);
  const parentInfo = await requiredLstat(parent, 'Move destination parent', 'MISSING_DESTINATION_PARENT');
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new SafeFilesystemPolicyError('UNSAFE_DESTINATION_PARENT', 'Move destination parent must be a real directory');
  }
  await assertPathComponentsAreNotLinks(root, parent);
  const resolvedParent = await realpath(parent);
  if (!samePath(root, resolvedParent) && !strictlyInside(root, resolvedParent)) {
    throw new SafeFilesystemPolicyError('REALPATH_ESCAPE', 'Move destination parent escaped the allowed root');
  }
}

/** @param {MoveDirectoryOptions} options */
export async function safeMoveDirectory(options) {
  const command = 'filesystem.move-directory';
  let preflight;
  try {
    preflight = await preflightPath(options, 'directory', command);
    const destination = requireAbsolute(options.destinationPath, 'Move destination');
    assertExpectedName(basename(destination), options.expectedDestinationName, 'UNEXPECTED_DESTINATION_NAME');
    assertTargetDoesNotContainProtectedPath(destination, collectProtectedPaths(options.protectedPaths));
    if (samePath(preflight.resolvedTarget, destination)
      || strictlyInside(preflight.resolvedTarget, destination)) {
      throw new SafeFilesystemPolicyError('UNSAFE_MOVE_DESTINATION', 'Move destination cannot be the source or inside it');
    }
    await assertSafeMoveDestination(preflight.resolvedRoot, destination);
    if (preflight.dryRun) {
      return { status: 'dry-run', sourcePath: preflight.resolvedTarget, destinationPath: destination };
    }
    await assertTargetUnchanged(preflight);
    await assertSafeMoveDestination(preflight.resolvedRoot, destination);
    await rename(preflight.resolvedTarget, destination);
    emitAudit(options, {
      command,
      decision: 'complete',
      reason: preflight.reason,
      target: preflight.lexicalTarget,
      resolvedTarget: preflight.resolvedTarget,
      allowedRoot: preflight.resolvedRoot,
      destination,
      entryCount: preflight.entryCount,
    });
    return { status: 'moved', sourcePath: preflight.resolvedTarget, destinationPath: destination };
  } catch (error) {
    if (preflight) {
      emitAudit(options, {
        command,
        decision: 'deny',
        reason: preflight.reason,
        target: preflight.lexicalTarget,
        resolvedTarget: preflight.resolvedTarget,
        allowedRoot: preflight.resolvedRoot,
        entryCount: preflight.entryCount,
        code: errorCode(error),
        detail: errorMessage(error),
      });
    }
    throw error;
  }
}
