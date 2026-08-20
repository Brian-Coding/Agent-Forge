import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const clientSource = readFileSync(join(import.meta.dir, 'index.html'), 'utf8');

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

test('every published Atlas re-scan entry point requires confirmation', () => {
  expect(clientSource).toContain("const ATLAS_RESCAN_CONFIRMATION = 'Re-scan the UI Atlas now?");
  expect(clientSource.match(/window\.confirm\(ATLAS_RESCAN_CONFIRMATION\)\) onRescanAtlas\(/g)).toHaveLength(2);
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
  expect(clientSource).toContain('activeLiveTurn?.lastProviderEventAt || null');
  expect(clientSource).toContain("isActive: isWorking");
  expect(clientSource).toContain('(possibly stalled)');
  expect(clientSource).not.toContain('(may be stuck)');
});

test('long elapsed durations roll up into days, hours, minutes, and seconds', () => {
  const start = clientSource.indexOf('function formatElapsedDuration(');
  const end = clientSource.indexOf('\n\n    // Hook: elapsed time', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const formatElapsedDuration = new Function(
    `${clientSource.slice(start, end)}; return formatElapsedDuration;`,
  )() as (seconds: number) => string;

  expect(formatElapsedDuration(0)).toBe('0s');
  expect(formatElapsedDuration(59)).toBe('59s');
  expect(formatElapsedDuration(60)).toBe('1m 0s');
  expect(formatElapsedDuration(3_600)).toBe('1h 0m 0s');
  expect(formatElapsedDuration(86_400)).toBe('1d 0h 0m 0s');
  expect(formatElapsedDuration((3_724 * 60) + 28)).toBe('2d 14h 4m 28s');
});

test('Claude model-specific weekly usage renders as Fable in both limits surfaces', () => {
  expect(clientSource).toContain("snap.provider === 'claude' && Number.isFinite(snap.modelWeekly?.usedPercent)");
  expect(clientSource).toContain("e(LimitsMeter, { label: 'Fable', window: snap.modelWeekly })");
  expect(clientSource).toContain("{ key: 'modelWeekly', label: 'Fable', data: snap.modelWeekly }");
});

test('the browser application inline script remains syntactically valid', () => {
  const start = clientSource.lastIndexOf('<script>');
  const end = clientSource.lastIndexOf('</script>');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(() => new Function(clientSource.slice(start + '<script>'.length, end))).not.toThrow();
});
