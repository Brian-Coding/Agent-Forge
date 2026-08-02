import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const snapshotOnly = args.has('--snapshot-only');
const knownArgs = new Set(['--dry-run', '--snapshot-only', '--help']);

function usage(): void {
  console.log(`Usage: bun run usage:sync [--dry-run] [--snapshot-only]

Snapshots this machine's Agent Forge token-usage shard in Git.

  --dry-run        Validate and print the actions without changing Git.
  --snapshot-only  Create the local snapshot commit, but do not pull or push.
  --help           Show this help.

Normal mode creates a machine-specific snapshot commit, pulls/rebases usage
snapshots from other machines, and pushes the current branch.`);
}

if (args.has('--help')) {
  usage();
  process.exit(0);
}

const unknownArgs = [...args].filter(arg => !knownArgs.has(arg));
if (unknownArgs.length > 0) {
  console.error(`Unknown argument(s): ${unknownArgs.join(', ')}`);
  usage();
  process.exit(2);
}

function sanitizeMachineId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
}

const machineId = sanitizeMachineId(process.env.AGENT_FORGE_MACHINE_ID || hostname() || 'local');
const shardRelativePath = `.agent-forge-sync/usage/${machineId}.json`;
const shardPath = resolve(repoRoot, shardRelativePath);

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

function validateShard(): { eventCount: number; totalTokens: number; earliest: string; latest: string } {
  if (!existsSync(shardPath)) {
    throw new Error(
      `No usage shard exists for ${machineId} at ${shardRelativePath}. `
      + 'Start Agent Forge once so it can create the shard.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(shardPath, 'utf8'));
  } catch (error) {
    throw new Error(`The usage shard is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('The usage shard must contain a JSON array.');

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
  return { eventCount: parsed.length, totalTokens, earliest: iso(earliest), latest: iso(latest) };
}

function statusPaths(): string[] {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']).stdout;
  if (!status) return [];
  return status.split(/\r?\n/).map(line => line.slice(3).replace(/^"|"$/g, '').replace(/\\/g, '/'));
}

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(tokens));
}

try {
  if (git(['rev-parse', '--is-inside-work-tree'], true).stdout !== 'true') {
    throw new Error(`${repoRoot} is not a Git worktree.`);
  }
  const branch = git(['branch', '--show-current']).stdout;
  if (!branch) throw new Error('Usage synchronization is disabled in detached-HEAD state.');

  const summary = validateShard();
  console.log(`Machine: ${machineId}`);
  console.log(`Shard: ${shardRelativePath}`);
  console.log(`Events: ${summary.eventCount}`);
  console.log(`Tokens: ${formatTokens(summary.totalTokens)}`);
  console.log(`Range: ${summary.earliest} to ${summary.latest}`);

  const unrelatedChanges = statusPaths().filter(path => path !== shardRelativePath);
  if (unrelatedChanges.length > 0) {
    throw new Error(
      'Refusing to synchronize while unrelated worktree changes are present:\n'
      + unrelatedChanges.map(path => `  - ${path}`).join('\n')
      + '\nCommit, stash, or otherwise resolve them first. Nothing was changed.',
    );
  }

  const tracked = git(['ls-files', '--error-unmatch', '--', shardRelativePath], true).exitCode === 0;
  const workingChanged = !tracked || git(['diff', '--quiet', '--', shardRelativePath], true).exitCode !== 0;
  const stagedChanged = git(['diff', '--cached', '--quiet', '--', shardRelativePath], true).exitCode !== 0;
  const needsSnapshot = workingChanged || stagedChanged;
  const commitMessage = `chore(usage): snapshot ${machineId}`;

  if (dryRun) {
    console.log(needsSnapshot
      ? `[dry-run] Would stage ${shardRelativePath} and commit: ${commitMessage}`
      : '[dry-run] Local usage shard already matches Git.');
    if (!snapshotOnly) {
      console.log(`[dry-run] Would run git pull --rebase on ${branch}.`);
      console.log(`[dry-run] Would run git push on ${branch}.`);
    }
    process.exit(0);
  }

  if (needsSnapshot) {
    git(['add', '--', shardRelativePath]);
    git(['commit', '-m', commitMessage, '--', shardRelativePath]);
    console.log(`Created snapshot commit for ${machineId}.`);
  } else {
    console.log('Local usage shard already matches Git.');
  }

  if (snapshotOnly) {
    console.log('Snapshot-only mode: skipped pull and push.');
    process.exit(0);
  }

  git(['pull', '--rebase']);
  git(['push']);
  console.log(`Usage snapshots synchronized successfully on ${branch}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
