import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATIC_AGENT_DEFINITIONS } from '../server/agents/agent-kinds';

const clientSource = readFileSync(join(import.meta.dir, 'index.html'), 'utf8');
const normalizedClientSource = clientSource.replace(/\r\n/g, '\n');

test('browser fallback model IDs and defaults agree with the server registry', () => {
  const start = normalizedClientSource.indexOf('const FALLBACK_AGENT_PROVIDERS =');
  const end = normalizedClientSource.indexOf('let AGENT_PROVIDERS =', start);
  const fallbacks = new Function(`${normalizedClientSource.slice(start, end)}; return FALLBACK_AGENT_PROVIDERS;`)();
  for (const fallback of fallbacks) {
    const server = STATIC_AGENT_DEFINITIONS[fallback.kind as keyof typeof STATIC_AGENT_DEFINITIONS];
    expect(fallback.defaultModel).toBe(server.defaultModel);
    expect(fallback.models.map(({ id, description, supportedReasoningLevels, defaultReasoningLevel }: any) => ({ id, description, supportedReasoningLevels, defaultReasoningLevel })))
      .toEqual(server.models.map(({ id, description, supportedReasoningLevels, defaultReasoningLevel }) => ({ id, description, supportedReasoningLevels, defaultReasoningLevel })));
  }
});

test('workspace selection remains local to each browser client', () => {
  expect(clientSource).toContain("const ACTIVE_WORKSPACE_STORAGE_KEY = 'agent-forge:active-workspace-id';");
  expect(clientSource).toContain('const [activeWorkspaceId, setActiveWorkspaceId] = useState(readStoredActiveWorkspaceId);');
  expect(clientSource).toContain('setActiveWorkspace: selectActiveWorkspace');
  expect(clientSource).toContain('workspaces.find(w => w.id === activeWorkspaceId)');
  expect(clientSource).not.toContain("sendRaw({ type: 'set_active_workspace'");
});

test('server settings updates cannot replace a valid local workspace selection', () => {
  expect(clientSource).toMatch(/case 'settings':\s*setSettings\(msg\.settings\);\s*break;/);
  expect(clientSource).toContain('workspaces.some(workspace => workspace.id === activeWorkspaceId)');
});

test('features that moved to separate projects stay out of the harness client', () => {
  for (const removed of ['/api/atlas/', '/api/qa/', '/api/browser/', '/api/google-docs', '/api/integrations/', 'send_qa_message', 'provision_atlas_agent', 'AtlasPanel', 'hideFromGrid']) {
    expect(clientSource).not.toContain(removed);
  }
});

test('chat image batches use the 100-image native upload path instead of base64 WebSocket frames', () => {
  expect(clientSource).toContain('const MAX_CHAT_IMAGES = 100;');
  expect(clientSource).toContain("fetch('/api/chat/image-upload?' + query.toString()");
  expect(clientSource).toContain("type: 'send_uploaded_images'");
  expect(clientSource).toContain('imageAttachments: m.imageAttachments');
  expect(clientSource).not.toContain('reader.readAsDataURL(file)');
});

test('token usage exports follow the selected machine scope', () => {
  expect(clientSource).toContain("'&scope=' + encodeURIComponent(scope)");
  expect(clientSource).toContain('Download the selected machine scope as CSV');
  expect(clientSource).toContain('Download the selected machine scope as JSON');
});

test('auth recovery actions stay on the preserved prompt and stay provider-specific', () => {
  expect(clientSource).toContain("'Check again'");
  expect(clientSource).toContain("'Retry preserved prompt'");
  expect(clientSource).toContain('Codex reauthentication required');
  expect(clientSource).toContain('Claude reauthentication required');
  expect(clientSource).toContain("type: 'check_auth'");
  expect(clientSource).toContain("type: 'retry_auth_prompt'");
  expect(clientSource).toContain('item.messageId === m.id');
});

test('every user message keeps a retry action bound to its own text or image attachments', () => {
  expect(clientSource).toContain("showRetry: m.role === 'user'");
  expect(clientSource).toContain('retryDisabled: isWorking || !!agent.modelMismatch');
  expect(clientSource).toContain("onRetry: m.role === 'user'");
  expect(clientSource).toContain('message.imageAttachments?.length');
  expect(clientSource).toContain('message.content.replace(');
  expect(clientSource).toContain('Resend this message as a new turn at the end of the conversation');
  expect(clientSource).not.toContain('realIdx === lastUserMsgIndex');
});

test('transport retries stay in the originating pane and genuine errors identify their agent', () => {
  expect(clientSource).toContain("activity.kind === 'transport' ? ' transport' : ''");
  expect(clientSource).toContain('title: activity.detail || undefined');
  expect(clientSource).toContain("current.kind !== msg.kind");
  expect(clientSource).toContain("sourceAgent.name + ': ' + msg.message");
  expect(clientSource).toContain("const toastKey = (msg.agentId || 'global')");
});

test('finished turns retain one canonical outcome without breaking idle queue semantics', () => {
  expect(clientSource).toContain('function agentPresentationStatus(agent)');
  expect(clientSource).toContain("agent.lastTurnOutcome?.status === 'failed'");
  expect(clientSource).toContain("title: 'Transport retry recorded'");
  expect(clientSource).toContain("? 'Turn stopped by you'");
  expect(clientSource).toContain("'Retry last request'");
  expect(clientSource).toContain("notification === 'failed'");
  expect(clientSource).toContain('const notifiedOutcomeRef = useRef(');
  expect(clientSource).toContain('setNotification(agent.lastTurnOutcome.status)');
  expect(clientSource).not.toContain("agent.lastTurnOutcome?.status || 'completed'");
});

test('file changes are reviewable and composer controls are explicit', () => {
  expect(clientSource).toContain("fetch('/api/git-diff?' + query.toString())");
  expect(clientSource).toContain("showFileChanges ? 'Hide files' : 'Review files'");
  expect(clientSource).toContain("copiedFilePath === file ? 'Copied' : 'Copy path'");
  expect(clientSource).toContain("isWorking ? 'Queue' : 'Send'");
  expect(clientSource).toContain("e('span', { className: 'agent-control-label' }, 'Reasoning')");
  expect(clientSource).toContain("tokenUsage.numTurns === 1 ? 'turn' : 'turns'");
});

test('live turn snapshots restore progress and use provider activity for stall detection', () => {
  expect(clientSource).toContain("case 'live_turn_state':");
  expect(clientSource).toContain('previous.turnId === state.turnId');
  expect(clientSource).toContain('Number(previous.revision || 0) >= Number(state.revision || 0)');
  expect(clientSource).toContain('live?.lastProviderEventAt');
  expect(clientSource).toContain("isActive: execution.active");
  expect(clientSource).toContain('(possibly stalled)');
  expect(clientSource).not.toContain('(may be stuck)');
});

test('long elapsed durations roll up into days, hours, minutes, and seconds', () => {
  const start = normalizedClientSource.indexOf('function formatElapsedDuration(');
  const end = normalizedClientSource.indexOf('\n\n    // Hook: elapsed time', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const formatElapsedDuration = new Function(
    `${normalizedClientSource.slice(start, end)}; return formatElapsedDuration;`,
  )() as (seconds: number) => string;

  expect(formatElapsedDuration(0)).toBe('0s');
  expect(formatElapsedDuration(59)).toBe('59s');
  expect(formatElapsedDuration(60)).toBe('1m 0s');
  expect(formatElapsedDuration(3_600)).toBe('1h 0m 0s');
  expect(formatElapsedDuration(86_400)).toBe('1d 0h 0m 0s');
  expect(formatElapsedDuration((3_724 * 60) + 28)).toBe('2d 14h 4m 28s');
});

test('folder-browser parent navigation preserves Windows drive roots and POSIX roots', () => {
  const start = normalizedClientSource.indexOf('function normalizeDirectoryPath(');
  const end = normalizedClientSource.indexOf('\n\n    // Folder Browser', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const parentDirectoryPath = new Function(
    `${normalizedClientSource.slice(start, end)}; return parentDirectoryPath;`,
  )() as (path: string) => string;

  expect(parentDirectoryPath('C:\\Users\\dev\\code')).toBe('C:/Users/dev');
  expect(parentDirectoryPath('C:\\Users')).toBe('C:/');
  expect(parentDirectoryPath('C:\\')).toBe('C:/');
  expect(parentDirectoryPath('/Users/dev/code')).toBe('/Users/dev');
  expect(parentDirectoryPath('/')).toBe('/');
  expect(parentDirectoryPath('\\\\server\\share\\folder')).toBe('//server/share');
  expect(parentDirectoryPath('\\\\server\\share')).toBe('//server/share');
});

test('Claude model-specific weekly usage renders as Fable in both limits surfaces', () => {
  expect(clientSource).toContain("snap.provider === 'claude' && Number.isFinite(snap.modelWeekly?.usedPercent)");
  expect(clientSource).toContain("e(LimitsMeter, { label: 'Fable', window: snap.modelWeekly })");
  expect(clientSource).toContain("{ key: 'modelWeekly', label: 'Fable', data: snap.modelWeekly }");
});

test('folder input distinguishes pasted absolute paths from list filters', () => {
  const start = normalizedClientSource.indexOf('function isDirectoryPathInput(');
  const end = normalizedClientSource.indexOf('\n\n    // Folder Browser', start);
  const isPath = new Function(`${normalizedClientSource.slice(start, end)}; return isDirectoryPathInput;`)();
  for (const path of ['/tmp/acme notes', '~/projects', '~', 'C:\\Users\\dev\\code', 'C:/', '\\\\server\\share', ' /tmp ']) {
    expect(isPath(path)).toBe(true);
  }
  for (const filter of ['projects', '', 'dev/code', '~someone', 'C:relative']) {
    expect(isPath(filter)).toBe(false);
  }
});

test('the browser application inline script remains syntactically valid', () => {
  const start = clientSource.lastIndexOf('<script>');
  const end = clientSource.lastIndexOf('</script>');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(() => new Function(clientSource.slice(start + '<script>'.length, end))).not.toThrow();
});
