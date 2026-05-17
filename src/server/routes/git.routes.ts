import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { jsonResponse } from '../utils';

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
