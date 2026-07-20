import { realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { agentService } from '../services/agent.service';

const MAX_PROJECT_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const PROJECT_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yml', '.yaml', '.csv', '.log']);

export class ProjectFileAccessError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ProjectFileAccessError';
  }
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function resolveProjectTextFile(projectRoot: string, requestedPath: string): string {
  if (!isAbsolute(requestedPath)) throw new ProjectFileAccessError('An absolute project file path is required', 400);
  const root = resolve(projectRoot);
  const requested = resolve(requestedPath);
  if (!isPathInside(root, requested)) throw new ProjectFileAccessError('File is outside this agent project', 403);
  if (!PROJECT_TEXT_EXTENSIONS.has(extname(requested).toLowerCase())) {
    throw new ProjectFileAccessError('Only project text and report files can be opened', 400);
  }

  let realRoot: string;
  let realRequested: string;
  try {
    realRoot = realpathSync(root);
    realRequested = realpathSync(requested);
  } catch {
    throw new ProjectFileAccessError('Project file not found', 404);
  }
  if (!isPathInside(realRoot, realRequested)) throw new ProjectFileAccessError('File resolves outside this agent project', 403);

  const stat = statSync(realRequested);
  if (!stat.isFile()) throw new ProjectFileAccessError('Project path is not a file', 400);
  if (stat.size > MAX_PROJECT_TEXT_FILE_BYTES) throw new ProjectFileAccessError('Project file is too large to display', 413);
  return realRequested;
}

export function handleProjectFile(req: Request): Response {
  try {
    const url = new URL(req.url);
    const agentId = url.searchParams.get('agentId');
    const requestedPath = url.searchParams.get('path');
    if (!agentId) throw new ProjectFileAccessError('agentId is required', 400);
    if (!requestedPath) throw new ProjectFileAccessError('path is required', 400);
    const agent = agentService.getAgent(agentId);
    if (!agent) throw new ProjectFileAccessError('Agent not found', 404);

    const filePath = resolveProjectTextFile(agent.cwd, requestedPath);
    const filename = basename(filePath).replace(/["\r\n]/g, '_');
    return new Response(Bun.file(filePath), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const status = error instanceof ProjectFileAccessError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unable to open project file';
    return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
