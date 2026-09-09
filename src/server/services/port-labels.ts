export interface PortWorkspaceHint {
  name: string;
  cwd?: string;
  testUrl?: string;
}

export interface PortLabelInput {
  port: number;
  pid: number;
  command: string;
  commandLine?: string | null;
  workspaces?: readonly PortWorkspaceHint[];
  listenPort?: number;
  selfPid?: number;
}

export interface PortLabel {
  label: string;
  self: boolean;
}

const JUNK_PATH_SEGMENTS = new Set([
  'bin', 'dist', 'src', 'app', 'apps', 'node_modules', 'scripts', 'server',
  'client', 'backend', 'frontend', 'public', 'build', 'out', 'cmd', 'exe',
  'nodejs', 'nvm4w', 'nvm', 'npm', 'yarn', 'pnpm', 'roaming', 'appdata',
  'local', 'programs', 'program files', 'program files (x86)', 'program',
  'data', 'cache', 'users', 'windows', 'system32', 'win64', 'binaries',
  'engine', 'resources', 'helpers', 'temp', 'tmp', 'documents',
]);

const NO_PROJECT_SUFFIX = new Set([
  'NordVPN', 'Zen Browser', 'Unreal Editor', 'Unreal Trace',
  'Epic Games Launcher', 'Epic Online Services', 'VS Code', 'Cursor', 'Docker',
]);

const PROCESS_NAMES: Record<string, string> = {
  unrealeditor: 'Unreal Editor',
  'unrealeditor-win64-debuggame': 'Unreal Editor',
  'nordvpn-service': 'NordVPN',
  nordvpn: 'NordVPN',
  zenserver: 'Zen Browser',
  zen: 'Zen Browser',
  postgres: 'Postgres',
  postgresql: 'Postgres',
  redis: 'Redis',
  'redis-server': 'Redis',
  mongod: 'MongoDB',
  mysqld: 'MySQL',
  nginx: 'Nginx',
  ollama: 'Ollama',
  docker: 'Docker',
  'com.docker.backend': 'Docker',
  code: 'VS Code',
  'code - insiders': 'VS Code',
  cursor: 'Cursor',
  unrealtraceserver: 'Unreal Trace',
  epicgameslauncher: 'Epic Games Launcher',
  epiconlineservicesuserhelper: 'Epic Online Services',
};

export function portFromUrl(url?: string): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      const port = Number(parsed.port);
      return Number.isSafeInteger(port) && port > 0 ? port : null;
    }
    if (parsed.protocol === 'https:') return 443;
    if (parsed.protocol === 'http:') return 80;
  } catch {
    const match = url.match(/:(\d+)(?:\/|$)/);
    if (!match) return null;
    const port = Number(match[1]);
    return Number.isSafeInteger(port) && port > 0 ? port : null;
  }
  return null;
}

/** WMIC `/FORMAT:LIST` blocks of CommandLine + ProcessId. */
export function parseWmicProcessList(text: string): Map<number, string> {
  const map = new Map<number, string>();
  let commandLine = '';
  let pid: number | null = null;
  const flush = () => {
    if (pid !== null && pid > 0 && commandLine) map.set(pid, commandLine);
    commandLine = '';
    pid = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const cmd = line.match(/^CommandLine=(.*)$/i);
    if (cmd) {
      commandLine = cmd[1]!.trim();
      continue;
    }
    const id = line.match(/^ProcessId=(\d+)$/i);
    if (id) pid = Number(id[1]);
  }
  flush();
  return map;
}

/** `ps -ax -o pid=,command=` rows. */
export function parsePsPidCommandList(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]!.trim();
    if (Number.isSafeInteger(pid) && pid > 0 && command) map.set(pid, command);
  }
  return map;
}

export function parsePowerShellProcessJson(text: string): Map<number, string> {
  const map = new Map<number, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return map;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as { ProcessId?: unknown; CommandLine?: unknown };
    const pid = typeof record.ProcessId === 'number' ? record.ProcessId : Number(record.ProcessId);
    const command = typeof record.CommandLine === 'string' ? record.CommandLine.trim() : '';
    if (Number.isSafeInteger(pid) && pid > 0 && command) map.set(pid, command);
  }
  return map;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function friendlyFolder(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pathCandidates(commandLine: string): string[] {
  const matches = commandLine.match(/[A-Za-z]:\\[^\s"]+|\/(?:Users|home|opt|var|usr)\/[^\s"]+/g) ?? [];
  return matches.map(value => value.replace(/["']+$/, ''));
}

export function projectNameFromCommandLine(commandLine: string): string | null {
  const candidates = pathCandidates(commandLine);
  const ordered = [
    ...candidates.filter(path => /node_modules/i.test(path)),
    ...candidates.filter(path => !/\.(exe|cmd)$/i.test(path)),
  ];
  for (const raw of ordered) {
    const normalized = raw.replace(/\\/g, '/');
    const nodeModules = normalized.toLowerCase().lastIndexOf('/node_modules/');
    const projectRoot = nodeModules >= 0 ? normalized.slice(0, nodeModules) : normalized;
    const parts = projectRoot.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]!;
      if (/^[A-Za-z]:$/.test(part)) continue;
      if (JUNK_PATH_SEGMENTS.has(part.toLowerCase())) continue;
      if (/\.(exe|cmd|js|mjs|cjs|ts|tsx)$/i.test(part)) continue;
      if (/^(node|bun|deno|python|python3|pwsh|powershell)$/i.test(part)) continue;
      return friendlyFolder(part);
    }
  }
  return null;
}

function inferKind(command: string, commandLine: string, port: number): string | null {
  const image = command.toLowerCase();
  const line = commandLine.toLowerCase();
  const named = PROCESS_NAMES[image];
  if (named) return named;

  if (line.includes('ai-agent-forge') || line.includes('agent-forge')) return 'Agent Forge';
  if (/\bvite\b/.test(line) || port === 5173 || port === 5174) return 'Vite';
  if (port === 4173 && (line.includes('vite') || image === 'node' || image === 'bun')) return 'Vite preview';
  if (/\btauri\b/.test(line) || port === 1420) return 'Tauri';
  if (/\bnext(?:\.js|\/)?/.test(line) || line.includes('next-server')) return 'Next.js';
  if (line.includes('webpack-dev-server') || line.includes('webpack serve')) return 'Webpack';
  if (line.includes('uvicorn') || line.includes('gunicorn') || line.includes('django') || line.includes('http.server')) {
    return 'Python server';
  }
  if (image === 'python' || image === 'python3') return 'Python';
  if (image === 'bun') return 'Bun app';
  if (image === 'deno') return 'Deno app';
  if (image === 'node') return 'Node app';
  if (port === 11434) return 'Ollama';
  if (port === 5432) return 'Postgres';
  if (port === 6379) return 'Redis';
  if (port === 27017) return 'MongoDB';
  return null;
}

function workspaceForPort(input: PortLabelInput, commandLine: string): string | null {
  const hints = input.workspaces ?? [];
  const line = normalizePath(commandLine);
  for (const workspace of hints) {
    if (portFromUrl(workspace.testUrl) === input.port && workspace.name.trim()) return workspace.name.trim();
  }
  for (const workspace of hints) {
    const cwd = workspace.cwd?.trim();
    if (!cwd || !workspace.name.trim()) continue;
    if (line.includes(normalizePath(cwd))) return workspace.name.trim();
  }
  return null;
}

export function labelListeningPort(input: PortLabelInput): PortLabel {
  const command = (input.command || 'unknown').trim() || 'unknown';
  const commandLine = input.commandLine?.trim() || '';
  const self = input.pid === input.selfPid
    || (input.listenPort === input.port && (command.toLowerCase() === 'bun' || command.toLowerCase() === 'node'));
  if (self) return { label: 'This Agent Forge', self: true };
  const workspace = workspaceForPort(input, commandLine);
  const kind = inferKind(command, commandLine, input.port);
  const project = workspace || projectNameFromCommandLine(commandLine);

  if (
    kind
    && project
    && !NO_PROJECT_SUFFIX.has(kind)
    && project.length <= 28
    && !kind.toLowerCase().includes(project.toLowerCase())
  ) {
    return { label: `${kind} · ${project}`, self };
  }
  if (kind) return { label: kind, self };
  if (project) return { label: project, self };
  const named = PROCESS_NAMES[command.toLowerCase()];
  return { label: named || humanizeImage(command), self };
}

function humanizeImage(command: string): string {
  const spaced = command
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced.replace(/\b\w/g, char => char.toUpperCase());
}
