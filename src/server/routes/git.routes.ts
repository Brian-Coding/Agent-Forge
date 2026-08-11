import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { jsonResponse } from '../utils';
import { agentService } from '../services/agent.service';

const MAX_GIT_DIFF_BYTES = 300_000;

/**
 * Read the current branch by parsing `.git/HEAD` directly — no subprocess.
 *
 * The previous implementation shelled out to `git rev-parse --abbrev-ref HEAD`
 * which on OneDrive-synced cwds runs ~200-500ms per call (Onedrive intercepts
 * the many stat() syscalls git does on .git/objects/*). With every agent
 * panel polling /api/git-branch every 10 seconds, that meant repeated CPU
 * spikes to 40-70%. Direct file read is sub-millisecond.
 *
 * Supports the three common cwd shapes:
 *   1. cwd/.git is a directory  (normal checkout) — read its HEAD
 *   2. cwd/.git is a file       (worktree / submodule) — resolve gitdir,
 *                                 then read that gitdir's HEAD
 *   3. cwd has no .git          (not a repo) — return null
 *
 * Detached HEAD (HEAD = a bare commit SHA, no "ref:" prefix) returns null.
 */
function readGitBranchSync(cwd: string): string | null {
  try {
    const dotGit = join(cwd, '.git');
    if (!existsSync(dotGit)) return null;

    let gitDir = dotGit;
    const stat = statSync(dotGit);
    if (stat.isFile()) {
      // Worktree/submodule: .git is a pointer file like "gitdir: ../.git/worktrees/foo"
      // (we use sync fs here to stay zero-async; the file is tiny and local)
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const content = readFileSync(dotGit, 'utf8');
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      const pointed = m[1]!.trim();
      gitDir = isAbsolute(pointed) ? pointed : resolve(cwd, pointed);
    } else if (!stat.isDirectory()) {
      return null;
    }

    const headPath = join(gitDir, 'HEAD');
    if (!existsSync(headPath)) return null;
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const head = readFileSync(headPath, 'utf8');
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/m);
    return refMatch ? refMatch[1]!.trim() : null;
  } catch {
    return null;
  }
}

export async function handleGitBranch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  if (!path) return jsonResponse({ branch: null });
  return jsonResponse({ branch: readGitBranchSync(path) });
}

export function resolveGitDiffTarget(projectRoot: string, requestedPath: string): { absolutePath: string; relativePath: string } {
  const root = resolve(projectRoot);
  const absolutePath = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
  const relativePath = relative(root, absolutePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Changed file is outside this agent project');
  }
  return { absolutePath, relativePath };
}

async function runGit(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function boundedDiff(text: string): { diff: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_GIT_DIFF_BYTES) return { diff: text, truncated: false };
  return {
    diff: Buffer.from(text, 'utf8').subarray(0, MAX_GIT_DIFF_BYTES).toString('utf8') + '\n\n[Diff truncated by Agent Forge]',
    truncated: true,
  };
}

export async function handleGitDiff(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const agentId = url.searchParams.get('agentId');
    const requestedPath = url.searchParams.get('path');
    if (!agentId || !requestedPath) return jsonResponse({ error: 'agentId and path are required' }, 400);
    const agent = agentService.getAgent(agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    const target = resolveGitDiffTarget(agent.cwd, requestedPath);

    const tracked = await runGit(agent.cwd, ['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--', target.relativePath]);
    if (tracked.stdout.trim()) {
      return jsonResponse({ file: target.relativePath, kind: 'diff', ...boundedDiff(tracked.stdout) });
    }

    const untracked = await runGit(agent.cwd, ['ls-files', '--others', '--exclude-standard', '--', target.relativePath]);
    if (untracked.stdout.trim()) {
      if (!existsSync(target.absolutePath) || !statSync(target.absolutePath).isFile()) {
        return jsonResponse({ error: 'Changed file no longer exists' }, 404);
      }
      // Lexical containment is not enough for untracked files: Bun.file()
      // follows symlinks. Resolve both sides before reading so a project-local
      // link cannot expose a file elsewhere on the machine.
      resolveGitDiffTarget(realpathSync(agent.cwd), realpathSync(target.absolutePath));
      const file = Bun.file(target.absolutePath);
      const bytes = Buffer.from(await file.slice(0, MAX_GIT_DIFF_BYTES + 1).arrayBuffer());
      if (bytes.includes(0)) return jsonResponse({ file: target.relativePath, kind: 'binary', diff: 'Binary file — text diff unavailable.', truncated: false });
      const additions = bytes.toString('utf8').split(/\r?\n/).map(line => `+${line}`).join('\n');
      const sourceWasTruncated = file.size > MAX_GIT_DIFF_BYTES;
      const synthetic = `--- /dev/null\n+++ b/${target.relativePath.replace(/\\/g, '/')}\n@@ new file @@\n${additions}`
        + (sourceWasTruncated ? '\n+[File preview truncated by Agent Forge]' : '');
      return jsonResponse({ file: target.relativePath, kind: 'untracked', ...boundedDiff(synthetic) });
    }

    if (tracked.exitCode !== 0) {
      return jsonResponse({ error: tracked.stderr.trim() || 'Unable to read Git diff' }, 400);
    }
    return jsonResponse({
      file: target.relativePath,
      kind: 'clean',
      diff: 'No pending Git diff is available. The file may have been committed or changed back.',
      truncated: false,
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unable to read Git diff' }, 400);
  }
}
