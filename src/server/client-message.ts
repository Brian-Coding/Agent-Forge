import type { ClientMessage } from '../shared/protocol';
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_TOTAL_BYTES } from './services/chat-image.service';

export const MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 256;
const MAX_PATH_CHARS = 32_768;
const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_COMMAND_CHARS = 128 * 1024;
const MAX_ID_LIST = 1_024;

export class ClientMessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientMessageValidationError';
  }
}

type JsonObject = Record<string, unknown>;

function fail(message: string): never {
  throw new ClientMessageValidationError(message);
}

function object(value: unknown, field = 'message'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[], required: readonly string[] = []): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) fail(`Unexpected field: ${key.slice(0, 80)}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`Missing field: ${key}`);
  }
}

function string(value: unknown, field: string, maxChars: number, nonEmpty = false): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.length > maxChars) fail(`${field} exceeds ${maxChars} characters`);
  if (nonEmpty && value.trim().length === 0) fail(`${field} cannot be empty`);
  return value;
}

function optionalString(value: unknown, field: string, maxChars: number, nonEmpty = false): void {
  if (value !== undefined) string(value, field, maxChars, nonEmpty);
}

function boolean(value: unknown, field: string): void {
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`);
}

function integer(value: unknown, field: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${field} must be an integer from ${min} to ${max}`);
  }
}

function stringArray(value: unknown, field: string, maxItems: number, maxChars = MAX_ID_CHARS): void {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > maxItems) fail(`${field} exceeds ${maxItems} items`);
  value.forEach((item, index) => string(item, `${field}[${index}]`, maxChars, true));
}

function optionalStringArray(value: unknown, field: string, maxItems: number, maxChars = MAX_ID_CHARS): void {
  if (value !== undefined) stringArray(value, field, maxItems, maxChars);
}

function optionalSlotIdArray(value: unknown, field: string, maxItems: number): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > maxItems) fail(`${field} exceeds ${maxItems} items`);
  value.forEach((item, index) => {
    if (item === '') return;
    string(item, `${field}[${index}]`, MAX_ID_CHARS, true);
  });
}

function id(value: unknown, field: string): void {
  string(value, field, MAX_ID_CHARS, true);
}

function optionalId(value: unknown, field: string): void {
  if (value !== undefined) id(value, field);
}

function noFields(message: JsonObject): void {
  exactKeys(message, ['type'], ['type']);
}

function validateSettings(value: unknown): void {
  const settings = object(value, 'settings');
  exactKeys(settings, [
    'defaultSimulatorUdid',
    'defaultSimulatorName',
    'activeWorkspaceId',
    'sidebarWidth',
    'gridColumns',
    'gridRows',
    'selectedAgentIds',
  ]);
  optionalString(settings.defaultSimulatorUdid, 'settings.defaultSimulatorUdid', MAX_ID_CHARS);
  optionalString(settings.defaultSimulatorName, 'settings.defaultSimulatorName', MAX_NAME_CHARS);
  optionalId(settings.activeWorkspaceId, 'settings.activeWorkspaceId');
  if (settings.sidebarWidth !== undefined) integer(settings.sidebarWidth, 'settings.sidebarWidth', 100, 2_000);
  if (settings.gridColumns !== undefined) integer(settings.gridColumns, 'settings.gridColumns', 1, 12);
  if (settings.gridRows !== undefined) integer(settings.gridRows, 'settings.gridRows', 1, 12);
  optionalSlotIdArray(settings.selectedAgentIds, 'settings.selectedAgentIds', MAX_ID_LIST);
}

function validateInlineImage(value: unknown, field: string): void {
  const image = object(value, field);
  exactKeys(image, ['imageData', 'mimeType'], ['imageData', 'mimeType']);
  string(image.imageData, `${field}.imageData`, MAX_WEBSOCKET_MESSAGE_BYTES, true);
  string(image.mimeType, `${field}.mimeType`, 128, true);
}

function validateUploadedImage(value: unknown, field: string): void {
  const image = object(value, field);
  exactKeys(image, ['path', 'name', 'mimeType', 'size'], ['path', 'name', 'mimeType', 'size']);
  string(image.path, `${field}.path`, MAX_PATH_CHARS, true);
  string(image.name, `${field}.name`, MAX_NAME_CHARS, true);
  string(image.mimeType, `${field}.mimeType`, 128, true);
  integer(image.size, `${field}.size`, 1, MAX_CHAT_IMAGE_TOTAL_BYTES);
}

function validateImageArray(
  value: unknown,
  field: string,
  validate: (item: unknown, itemField: string) => void,
): void {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length < 1 || value.length > MAX_CHAT_IMAGES) {
    fail(`${field} must contain 1 to ${MAX_CHAT_IMAGES} images`);
  }
  value.forEach((item, index) => validate(item, `${field}[${index}]`));
}

/** Strictly validate an already-decoded JSON value as a client command. */
export function validateClientMessage(value: unknown): ClientMessage {
  const message = object(value);
  const type = string(message.type, 'type', 64, true);

  switch (type) {
    case 'ping':
    case 'get_shared_context':
    case 'list_agents':
    case 'get_settings':
    case 'get_workspaces':
    case 'get_terminals':
    case 'refresh_limits':
    case 'kill_all':
      noFields(message);
      break;

    case 'create_agent':
      exactKeys(message, ['type', 'name', 'cwd', 'referencePaths', 'systemPrompt', 'workspaceId'], ['type', 'name', 'cwd']);
      string(message.name, 'name', MAX_NAME_CHARS, true);
      string(message.cwd, 'cwd', MAX_PATH_CHARS, true);
      optionalStringArray(message.referencePaths, 'referencePaths', 128, MAX_PATH_CHARS);
      optionalString(message.systemPrompt, 'systemPrompt', MAX_TEXT_CHARS);
      optionalId(message.workspaceId, 'workspaceId');
      break;

    case 'update_agent':
      exactKeys(message, ['type', 'id', 'name', 'cwd', 'referencePaths', 'systemPrompt', 'provider', 'model', 'reasoningLevel'], ['type', 'id']);
      id(message.id, 'id');
      optionalString(message.name, 'name', MAX_NAME_CHARS);
      optionalString(message.cwd, 'cwd', MAX_PATH_CHARS, true);
      optionalStringArray(message.referencePaths, 'referencePaths', 128, MAX_PATH_CHARS);
      optionalString(message.systemPrompt, 'systemPrompt', MAX_TEXT_CHARS);
      if (message.provider !== undefined && message.provider !== 'claude' && message.provider !== 'codex') {
        fail('provider must be claude or codex');
      }
      optionalString(message.model, 'model', MAX_NAME_CHARS);
      optionalString(message.reasoningLevel, 'reasoningLevel', 64);
      break;

    case 'resolve_model_mismatch':
      exactKeys(message, ['type', 'id', 'action'], ['type', 'id', 'action']);
      id(message.id, 'id');
      if (message.action !== 'continue-actual' && message.action !== 'fresh-requested') {
        fail('action must be continue-actual or fresh-requested');
      }
      break;

    case 'send_message':
      exactKeys(message, ['type', 'agentId', 'content'], ['type', 'agentId', 'content']);
      id(message.agentId, 'agentId');
      string(message.content, 'content', MAX_TEXT_CHARS);
      break;

    case 'kill_agent':
    case 'stop_agent':
    case 'remove_agent':
    case 'clear_history':
    case 'get_history':
      exactKeys(message, ['type', 'agentId'], ['type', 'agentId']);
      id(message.agentId, 'agentId');
      break;

    case 'update_shared_context':
      exactKeys(message, ['type', 'content'], ['type', 'content']);
      string(message.content, 'content', MAX_TEXT_CHARS);
      break;

    case 'update_settings':
      exactKeys(message, ['type', 'settings'], ['type', 'settings']);
      validateSettings(message.settings);
      break;

    case 'send_image':
      exactKeys(message, ['type', 'agentId', 'imageData', 'mimeType', 'prompt'], ['type', 'agentId', 'imageData', 'mimeType']);
      id(message.agentId, 'agentId');
      string(message.imageData, 'imageData', MAX_WEBSOCKET_MESSAGE_BYTES, true);
      string(message.mimeType, 'mimeType', 128, true);
      optionalString(message.prompt, 'prompt', MAX_TEXT_CHARS);
      break;

    case 'send_images':
      exactKeys(message, ['type', 'agentId', 'images', 'prompt'], ['type', 'agentId', 'images']);
      id(message.agentId, 'agentId');
      validateImageArray(message.images, 'images', validateInlineImage);
      optionalString(message.prompt, 'prompt', MAX_TEXT_CHARS);
      break;

    case 'send_uploaded_images':
      exactKeys(message, ['type', 'agentId', 'images', 'prompt'], ['type', 'agentId', 'images']);
      id(message.agentId, 'agentId');
      validateImageArray(message.images, 'images', validateUploadedImage);
      optionalString(message.prompt, 'prompt', MAX_TEXT_CHARS);
      break;

    case 'create_workspace':
      exactKeys(message, ['type', 'name'], ['type', 'name']);
      string(message.name, 'name', MAX_NAME_CHARS, true);
      break;

    case 'update_workspace':
      exactKeys(message, [
        'type',
        'id',
        'name',
        'gridColumns',
        'gridRows',
        'selectedAgentIds',
        'lockedAgentIds',
        'testUrl',
        'googleDocsTrackerEnabled',
      ], ['type', 'id']);
      id(message.id, 'id');
      optionalString(message.name, 'name', MAX_NAME_CHARS);
      if (message.gridColumns !== undefined) integer(message.gridColumns, 'gridColumns', 1, 12);
      if (message.gridRows !== undefined) integer(message.gridRows, 'gridRows', 1, 12);
      optionalSlotIdArray(message.selectedAgentIds, 'selectedAgentIds', MAX_ID_LIST);
      optionalStringArray(message.lockedAgentIds, 'lockedAgentIds', MAX_ID_LIST);
      optionalString(message.testUrl, 'testUrl', 8_192);
      if (message.googleDocsTrackerEnabled !== undefined) boolean(message.googleDocsTrackerEnabled, 'googleDocsTrackerEnabled');
      break;

    case 'reorder_workspaces':
      exactKeys(message, ['type', 'orderedIds'], ['type', 'orderedIds']);
      stringArray(message.orderedIds, 'orderedIds', MAX_ID_LIST);
      break;

    case 'delete_workspace':
    case 'set_active_workspace':
      exactKeys(message, ['type', 'id'], ['type', 'id']);
      id(message.id, 'id');
      break;

    case 'send_qa_message':
      exactKeys(message, ['type', 'workspaceId', 'sourceAgentId', 'content', 'rerunOf'], ['type', 'workspaceId', 'sourceAgentId', 'content']);
      id(message.workspaceId, 'workspaceId');
      id(message.sourceAgentId, 'sourceAgentId');
      string(message.content, 'content', MAX_TEXT_CHARS);
      optionalId(message.rerunOf, 'rerunOf');
      break;

    case 'abort_qa_test':
    case 'rescan_atlas':
    case 'resume_atlas':
    case 'discard_atlas_candidate':
      exactKeys(message, ['type', 'workspaceId'], ['type', 'workspaceId']);
      id(message.workspaceId, 'workspaceId');
      break;

    case 'handoff_qa_run':
      exactKeys(message, ['type', 'workspaceId', 'runId'], ['type', 'workspaceId', 'runId']);
      id(message.workspaceId, 'workspaceId');
      id(message.runId, 'runId');
      break;

    case 'provision_atlas_agent':
      exactKeys(message, ['type', 'workspaceId', 'projectCwd'], ['type', 'workspaceId', 'projectCwd']);
      id(message.workspaceId, 'workspaceId');
      string(message.projectCwd, 'projectCwd', MAX_PATH_CHARS, true);
      break;

    case 'create_terminal':
      exactKeys(message, ['type', 'agentId', 'command'], ['type', 'agentId', 'command']);
      id(message.agentId, 'agentId');
      string(message.command, 'command', MAX_COMMAND_CHARS);
      break;

    case 'kill_terminal':
      exactKeys(message, ['type', 'id'], ['type', 'id']);
      id(message.id, 'id');
      break;

    default:
      fail(`Unknown message type: ${type.slice(0, 64)}`);
  }

  return message as ClientMessage;
}

/** Decode, size-check, parse, and validate one WebSocket payload. */
export function parseClientMessage(
  raw: string | Uint8Array,
  maxBytes = MAX_WEBSOCKET_MESSAGE_BYTES,
): ClientMessage {
  const byteLength = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (byteLength > maxBytes) fail(`Message exceeds ${maxBytes} bytes`);
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    fail('Message is not valid UTF-8');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    fail('Message is not valid JSON');
  }
  return validateClientMessage(decoded);
}
