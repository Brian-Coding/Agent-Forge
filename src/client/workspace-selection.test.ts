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

test('every user message keeps a retry action bound to its own text or image attachments', () => {
  expect(clientSource).toContain("showRetry: m.role === 'user'");
  expect(clientSource).toContain('retryDisabled: isWorking || !!agent.modelMismatch');
  expect(clientSource).toContain("onRetry: m.role === 'user'");
  expect(clientSource).toContain('m.imageAttachments?.length');
  expect(clientSource).toContain("m.content.replace(/^\\[\\d+ images? attached at original resolution\\]\\s*/i, '')");
  expect(clientSource).toContain('Resend this message as a new turn at the end of the conversation');
  expect(clientSource).not.toContain('realIdx === lastUserMsgIndex');
});
