import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(): void {
  console.log(`Usage: bun run usage:sync [--dry-run] [--snapshot-only]

Snapshots this machine's Agent Forge token-usage shard in Git.

  --dry-run        Validate and print the actions without changing the worktree.
  --snapshot-only  Create the local snapshot commit, but do not pull or push.
  --help           Show this help.

Normal mode creates a machine-specific snapshot commit, pulls/rebases usage
snapshots from other machines, and pushes only when every pre-existing local
commit ahead of upstream is itself a usage-snapshot commit.`);
}

function sanitizeMachineId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
}

const machineId = sanitizeMachineId(process.env.AGENT_FORGE_MACHINE_ID || hostname() || 'local');
const runtimeDirectory = process.env.AGENT_FORGE_USAGE_SYNC_DIR
  || join(homedir(), '.agent-forge', 'usage-sync', 'usage');
const runtimeShardPath = join(runtimeDirectory, `${machineId}.json`);
const snapshotRelativePath = `.agent-forge-sync/usage/${machineId}.json`;
const snapshotPath = resolve(repoRoot, snapshotRelativePath);

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function git(commandArgs: string[], allowFailure = false): GitResult {
  const result = Bun.spawnSync({
    cmd: ['git', ...commandArgs],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (!allowFailure && result.exitCode !== 0) {
    const detail = stderr || stdout || `git exited with code ${result.exitCode}`;
    throw new Error(`git ${commandArgs.join(' ')} failed: ${detail}`);
  }
  return { exitCode: result.exitCode, stdout, stderr };
}

interface UsageShardSummary {
  events: Record<string, unknown>[];
  eventCount: number;
  totalTokens: number;
  earliest: string;
  latest: string;
}

function validateRuntimeShard(): UsageShardSummary {
  if (!existsSync(runtimeShardPath)) {
    throw new Error(
      `No runtime usage shard exists for ${machineId} at ${runtimeShardPath}. `
      + 'Restart Agent Forge once so it can migrate usage outside the repository.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(runtimeShardPath, 'utf8'));
  } catch (error) {
    throw new Error(`The runtime usage shard is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('The runtime usage shard must contain a JSON array.');

  let totalTokens = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const [index, raw] of parsed.entries()) {
    if (!raw || typeof raw !== 'object') throw new Error(`Usage event ${index} is not an object.`);
    const event = raw as Record<string, unknown>;
    if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) {
      throw new Error(`Usage event ${index} has an invalid timestamp.`);
    }
    const input = typeof event.inputTokens === 'number' && Number.isFinite(event.inputTokens) ? event.inputTokens : 0;
    const output = typeof event.outputTokens === 'number' && Number.isFinite(event.outputTokens) ? event.outputTokens : 0;
    totalTokens += input + output;
    earliest = Math.min(earliest, event.timestamp);
    latest = Math.max(latest, event.timestamp);
  }

  const iso = (timestamp: number) => Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'n/a';
  return {
    events: parsed as Record<string, unknown>[],
    eventCount: parsed.length,
    totalTokens,
    earliest: iso(earliest),
    latest: iso(latest),
  };
}

/** One event per line keeps snapshots compact while retaining reviewable diffs. */
export function serializeUsageSnapshot(events: readonly Record<string, unknown>[]): string {
  if (events.length === 0) return '[]\n';
  return `[\n${events.map(event => JSON.stringify(event)).join(',\n')}\n]\n`;
}

function statusPaths(): string[] {
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout;
  if (!status) return [];
  const entries = status.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const state = entry.slice(0, 2);
    paths.push(entry.slice(3).replace(/\\/g, '/'));
    if (state.includes('R') || state.includes('C')) index++;
  }
  return paths;
}

export function isUsageSnapshotPath(path: string): boolean {
  return /^\.agent-forge-sync\/usage\/[a-z0-9._-]+\.json$/.test(path.replace(/\\/g, '/'));
}

export function isUsageSnapshotCommit(subject: string, paths: readonly string[]): boolean {
  return subject.startsWith('chore(usage): snapshot ')
    && paths.length > 0
    && paths.every(isUsageSnapshotPath);
}

function upstreamRef(): string {
  const result = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], true);
  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error('Usage synchronization requires the current branch to have a configured upstream.');
  }
  return result.stdout;
}

function assertAheadCommitsAreUsageOnly(upstream: string): void {
  const hashes = git(['rev-list', '--reverse', `${upstream}..HEAD`]).stdout.split(/\r?\n/).filter(Boolean);
  const unsafe: string[] = [];
  for (const hash of hashes) {
    const subject = git(['show', '-s', '--format=%s', hash]).stdout;
    const paths = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', hash]).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    if (!isUsageSnapshotCommit(subject, paths)) {
      unsafe.push(`${hash.slice(0, 10)} ${subject}`);
    }
  }
  if (unsafe.length > 0) {
    throw new Error(
      'Refusing to push because the current branch contains non-usage commits that are not on upstream:\n'
      + unsafe.map(commit => `  - ${commit}`).join('\n')
      + '\nPush those commits deliberately yourself, or run with --snapshot-only.',
    );
  }
}

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(tokens));
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const snapshotOnly = args.has('--snapshot-only');
  const knownArgs = new Set(['--dry-run', '--snapshot-only', '--help']);

  if (args.has('--help')) {
    usage();
    return;
  }
  const unknownArgs = [...args].filter(arg => !knownArgs.has(arg));
  if (unknownArgs.length > 0) {
    console.error(`Unknown argument(s): ${unknownArgs.join(', ')}`);
    usage();
    process.exitCode = 2;
    return;
  }

  if (git(['rev-parse', '--is-inside-work-tree'], true).stdout !== 'true') {
    throw new Error(`${repoRoot} is not a Git worktree.`);
  }
  const branch = git(['branch', '--show-current']).stdout;
  if (!branch) throw new Error('Usage synchronization is disabled in detached-HEAD state.');

  const summary = validateRuntimeShard();
  const serializedSnapshot = serializeUsageSnapshot(summary.events);
  console.log(`Machine: ${machineId}`);
  console.log(`Runtime shard: ${runtimeShardPath}`);
  console.log(`Git snapshot: ${snapshotRelativePath}`);
  console.log(`Events: ${summary.eventCount}`);
  console.log(`Tokens: ${formatTokens(summary.totalTokens)}`);
  console.log(`Range: ${summary.earliest} to ${summary.latest}`);

  const unrelatedChanges = statusPaths().filter(path => path !== snapshotRelativePath);
  if (unrelatedChanges.length > 0) {
    throw new Error(
      'Refusing to synchronize while unrelated worktree changes are present:\n'
      + unrelatedChanges.map(path => `  - ${path}`).join('\n')
      + '\nCommit, stash, or otherwise resolve them first. Nothing was changed.',
    );
  }

  if (!snapshotOnly) {
    git(['fetch']);
    assertAheadCommitsAreUsageOnly(upstreamRef());
  }

  const existingSnapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : null;
  const stagedChanged = git(['diff', '--cached', '--quiet', '--', snapshotRelativePath], true).exitCode !== 0;
  const needsSnapshot = existingSnapshot !== serializedSnapshot || stagedChanged;
  const commitMessage = `chore(usage): snapshot ${machineId}`;

  if (dryRun) {
    console.log(needsSnapshot
      ? `[dry-run] Would write, stage, and commit ${snapshotRelativePath}: ${commitMessage}`
      : '[dry-run] Git snapshot already matches the runtime shard.');
    if (!snapshotOnly) {
      console.log(`[dry-run] Would run git pull --rebase on ${branch}.`);
      console.log(`[dry-run] Would run git push on ${branch}; only usage-snapshot commits are ahead.`);
    }
    return;
  }

  if (needsSnapshot) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const tempPath = `${snapshotPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, serializedSnapshot, 'utf8');
    renameSync(tempPath, snapshotPath);
    git(['add', '--', snapshotRelativePath]);
    git(['commit', '-m', commitMessage, '--', snapshotRelativePath]);
    console.log(`Created snapshot commit for ${machineId}.`);
  } else {
    console.log('Git snapshot already matches the runtime shard.');
  }

  if (snapshotOnly) {
    console.log('Snapshot-only mode: skipped pull and push.');
    return;
  }

  git(['pull', '--rebase']);
  git(['push']);
  console.log(`Usage snapshots synchronized successfully on ${branch}.`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
