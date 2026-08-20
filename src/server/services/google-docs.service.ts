import { createSign, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fetchWithTimeout } from './external-io';

const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
const DOCS_API = 'https://docs.googleapis.com/v1/documents';
const CONFIG_PATH = join(homedir(), '.agent-forge', 'google-docs.json');
const DEFAULT_CREDENTIAL_PATH = join(homedir(), '.agent-forge', 'credentials', 'google-docs-service-account.json');
export const GOOGLE_TOKEN_TIMEOUT_MS = 10_000;
export const GOOGLE_DOCS_TIMEOUT_MS = 15_000;

export interface GoogleDocsConfig {
  documentUrl: string;
  documentId: string;
  tabId?: string;
  credentialPath?: string;
}

interface ServiceAccountCredential {
  type: 'service_account';
  client_email: string;
  private_key: string;
  token_uri: string;
}

interface TokenCache {
  credentialPath: string;
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let guiPort = 3333;

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function safeGoogleError(status: number, payload: any): Error {
  const message = typeof payload?.error?.message === 'string'
    ? payload.error.message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    : `Google Docs API request failed (${status})`;
  return new Error(message.slice(0, 500));
}

export function validateServiceAccountCredential(credential: unknown): ServiceAccountCredential {
  const candidate = credential as any;
  if (candidate?.type !== 'service_account' || typeof candidate.client_email !== 'string'
      || !candidate.client_email.trim() || typeof candidate.private_key !== 'string' || !candidate.private_key.trim()
      || typeof candidate.token_uri !== 'string') {
    throw new Error('Google Docs credential file is not a valid service-account key');
  }
  let tokenUrl: URL;
  try { tokenUrl = new URL(candidate.token_uri); }
  catch { throw new Error('Google Docs credential token endpoint is invalid'); }
  if (tokenUrl.protocol !== 'https:' || !(tokenUrl.hostname === 'oauth2.googleapis.com' || tokenUrl.hostname.endsWith('.googleapis.com'))) {
    throw new Error('Google Docs credential token endpoint must be an HTTPS Google API endpoint');
  }
  return candidate as ServiceAccountCredential;
}

function readCredential(path: string): ServiceAccountCredential {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`Google Docs credential file was not found at ${path}`);
  let credential: any;
  try {
    credential = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Google Docs credential file is not valid JSON');
  }
  return validateServiceAccountCredential(credential);
}

async function getAccessToken(credentialPath: string): Promise<string> {
  if (tokenCache?.credentialPath === credentialPath && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }
  const credential = readCredential(credentialPath);
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credential.client_email,
    scope: DOCS_SCOPE,
    aud: credential.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(credential.private_key).toString('base64url')}`;
  const response = await fetchWithTimeout(credential.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  }, GOOGLE_TOKEN_TIMEOUT_MS, 'Google OAuth token request');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.access_token !== 'string' || !payload.access_token.trim()) {
    throw safeGoogleError(response.status, payload);
  }
  const rawExpiresIn = Number(payload.expires_in);
  const expiresIn = Number.isFinite(rawExpiresIn)
    ? Math.min(3_600, Math.max(60, rawExpiresIn))
    : 3_600;
  tokenCache = {
    credentialPath,
    accessToken: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return tokenCache.accessToken;
}

function readStructuralText(content: any[] | undefined): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const element of content) {
    if (element?.paragraph?.elements) {
      for (const part of element.paragraph.elements) text += part?.textRun?.content || '';
    }
    if (element?.table?.tableRows) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells || []) text += readStructuralText(cell.content);
      }
    }
    if (element?.tableOfContents?.content) text += readStructuralText(element.tableOfContents.content);
  }
  return text;
}

export interface GoogleDocumentTab {
  id: string;
  title: string;
  parentTabId?: string;
  index: number;
  nestingLevel: number;
  path: string[];
  text: string;
}

export interface GoogleDocumentTabNode extends GoogleDocumentTab {
  children: GoogleDocumentTabNode[];
}

function extractTabTree(tabs: any[] | undefined, parentTabId?: string, parentPath: string[] = [], depth = 0): GoogleDocumentTabNode[] {
  return (tabs || []).map((tab, siblingIndex) => {
    const properties = tab?.tabProperties || {};
    const id = String(properties.tabId || '');
    const title = String(properties.title || '');
    const path = [...parentPath, title];
    return {
      id,
      title,
      ...(parentTabId ? { parentTabId } : {}),
      index: Number.isInteger(properties.index) ? properties.index : siblingIndex,
      nestingLevel: Number.isInteger(properties.nestingLevel) ? properties.nestingLevel : depth,
      path,
      text: readStructuralText(tab?.documentTab?.body?.content),
      children: extractTabTree(tab?.childTabs, id || undefined, path, depth + 1),
    };
  });
}

function flattenExtractedTabs(tabs: GoogleDocumentTabNode[]): GoogleDocumentTab[] {
  return tabs.flatMap(({ children, ...tab }) => [tab, ...flattenExtractedTabs(children)]);
}

export function parseGoogleDocumentUrl(value: string): Pick<GoogleDocsConfig, 'documentUrl' | 'documentId' | 'tabId'> {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid Google Docs URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') throw new Error('Enter a docs.google.com document URL');
  const match = url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (!match?.[1]) throw new Error('The Google Docs URL does not contain a document ID');
  const tabId = url.searchParams.get('tab') || undefined;
  return { documentUrl: value.trim(), documentId: match[1], ...(tabId ? { tabId } : {}) };
}

export function extractGoogleDocument(document: any, configuredTabId?: string) {
  const tabTree = extractTabTree(document?.tabs);
  const tabs = flattenExtractedTabs(tabTree);
  const selected = (configuredTabId && tabs.find(tab => tab.id === configuredTabId)) || tabs[0];
  const tabId = selected?.id;
  const tabTitle = selected?.title;
  const text = selected ? selected.text : readStructuralText(document?.body?.content);
  return {
    title: String(document?.title || ''),
    revisionId: String(document?.revisionId || ''),
    tabId: tabId ? String(tabId) : undefined,
    tabTitle: tabTitle ? String(tabTitle) : undefined,
    text,
    tabs,
    tabTree,
  };
}

export function validateGoogleDocumentPayload(payload: unknown): asserts payload is Record<string, any> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Google Docs returned a malformed document response');
  }
  const document = payload as any;
  if (typeof document.documentId !== 'string' || !document.documentId
      || typeof document.title !== 'string'
      || typeof document.revisionId !== 'string' || !document.revisionId
      || (!Array.isArray(document.tabs) && (!document.body || typeof document.body !== 'object'))) {
    throw new Error('Google Docs returned an incomplete document response');
  }
}

export function validateGoogleBatchUpdatePayload(payload: unknown): asserts payload is Record<string, any> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || typeof (payload as any).documentId !== 'string' || !(payload as any).documentId
      || !Array.isArray((payload as any).replies)) {
    throw new Error('Google Docs returned a malformed write response');
  }
}

export function buildGoogleDocsAgentInstructions(config: GoogleDocsConfig, port: number): string {
  const base = `http://127.0.0.1:${port}/api/google-docs`;
  return `Google Docs Project Tracker (configured and write-enabled)
The allowlisted tracker is ${config.documentUrl}. Credentials remain server-side; never request, read, or print them.

Use the local Agent Forge endpoints with curl:
- GET ${base}/document — read every tab and subtab. The response includes ordered flat \`tabs\` and nested \`tabTree\` collections with each tab's \`id\`, \`title\`, \`parentTabId\`, \`nestingLevel\`, \`path\`, and \`text\`.
- POST ${base}/append-if-absent with JSON {"tabId":"target tab ID","text":"...","dedupeText":"..."} — add a genuinely new item to that exact tab without duplicating existing text there.
- POST ${base}/append with JSON {"tabId":"target tab ID","text":"...","revisionId":"revision from GET"} — append to that exact tab with revision protection.
- POST ${base}/replace with JSON {"tabId":"target tab ID","search":"exact existing text","replacement":"new text","revisionId":"revision from GET"} — update text only in that exact tab with revision protection.

Tracker workflow:
1. When the user asks what remains, discusses project status, or asks to reconcile work, read the tracker and inspect the repository's git history before answering. Mark or rewrite items only when repository evidence supports it.
2. When the user casually mentions a concrete new project task or requirement, read the tracker in the same turn. If it is not already represented, add it with append-if-absent. Do not add ordinary conversation, speculation, or non-project reminders.
3. Always pass the destination tab's explicit \`tabId\` for writes. Never infer nesting from titles alone; use \`parentTabId\`, \`path\`, and \`tabTree\`. To move an item, append it to the destination tab, verify it there, re-read for the new revision, then remove it from the source tab.
4. Preserve coworkers' wording and formatting wherever possible. Prefer targeted replacements and append-only additions; never replace a whole tab or document.
5. On a revision conflict, re-read the document, reconsider the change against the newest content, and retry only if still appropriate.
6. Document writes are authorized only for maintaining this configured project tracker. Explain material rewrites to the user.`;
}

function resolveCredentialPath(config: GoogleDocsConfig): string {
  return resolve(config.credentialPath || process.env.AGENT_FORGE_GOOGLE_DOCS_CREDENTIALS || DEFAULT_CREDENTIAL_PATH);
}

function readConfig(): GoogleDocsConfig | null {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!raw?.documentUrl) return null;
    return { ...parseGoogleDocumentUrl(raw.documentUrl), ...(raw.credentialPath ? { credentialPath: raw.credentialPath } : {}) };
  } catch {
    return null;
  }
}

function requireConfig(): GoogleDocsConfig {
  const config = readConfig();
  if (!config) throw new Error('Google Docs is not configured in Harness Settings');
  return config;
}

async function docsFetch(config: GoogleDocsConfig, suffix = '', init?: RequestInit): Promise<any> {
  const token = await getAccessToken(resolveCredentialPath(config));
  const response = await fetchWithTimeout(`${DOCS_API}/${encodeURIComponent(config.documentId)}${suffix}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers },
  }, GOOGLE_DOCS_TIMEOUT_MS, 'Google Docs API request');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw safeGoogleError(response.status, payload);
  return payload;
}

async function getDocument(config = requireConfig()) {
  const payload = await docsFetch(config, '?includeTabsContent=true');
  validateGoogleDocumentPayload(payload);
  return extractGoogleDocument(payload, config.tabId);
}

async function batchUpdate(config: GoogleDocsConfig, revisionId: string, requests: any[]) {
  if (!revisionId) throw new Error('A document revision ID is required for safe writes');
  const payload = await docsFetch(config, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revisionId } }),
  });
  validateGoogleBatchUpdatePayload(payload);
  return payload;
}

function resolveTargetTab(document: Awaited<ReturnType<typeof getDocument>>, configuredTabId: string | undefined, requestedTabId?: string): GoogleDocumentTab {
  const tabId = requestedTabId?.trim() || configuredTabId || document.tabId;
  if (!tabId) throw new Error('A destination tabId is required because this document has no default tab');
  const tab = document.tabs.find(candidate => candidate.id === tabId);
  if (!tab) throw new Error(`Google Docs tabId "${tabId}" was not found in the configured document`);
  return tab;
}

export const googleDocsService = {
  configPath: CONFIG_PATH,
  defaultCredentialPath: DEFAULT_CREDENTIAL_PATH,

  setGuiPort(port: number) { guiPort = port; },

  getConfig(): GoogleDocsConfig | null { return readConfig(); },

  async configure(documentUrl: string, credentialPath?: string) {
    const parsed = parseGoogleDocumentUrl(documentUrl);
    const requestedCredentialPath = credentialPath?.trim() ? resolve(credentialPath.trim()) : undefined;
    const config: GoogleDocsConfig = {
      ...parsed,
      ...(requestedCredentialPath && requestedCredentialPath !== resolve(DEFAULT_CREDENTIAL_PATH)
        ? { credentialPath: requestedCredentialPath }
        : {}),
    };
    const resolvedCredential = resolveCredentialPath(config);
    const repoRelative = relative(resolve(process.cwd()), resolvedCredential);
    if (repoRelative && !repoRelative.startsWith('..') && !isAbsolute(repoRelative)) {
      throw new Error('Store Google credentials outside the Agent Forge repository');
    }
    readCredential(resolvedCredential);
    const document = await getDocument(config);
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    await Bun.write(CONFIG_PATH, JSON.stringify({ documentUrl: config.documentUrl, ...(config.credentialPath ? { credentialPath: config.credentialPath } : {}) }, null, 2));
    return { config, document };
  },

  async getStatus() {
    const config = readConfig();
    if (!config) return { configured: false, connected: false, configPath: CONFIG_PATH, credentialPath: DEFAULT_CREDENTIAL_PATH };
    const credentialPath = resolveCredentialPath(config);
    const base = { configured: true, connected: false, documentUrl: config.documentUrl, documentId: config.documentId, tabId: config.tabId, configPath: CONFIG_PATH, credentialPath, credentialFound: existsSync(credentialPath) };
    if (!existsSync(credentialPath)) return base;
    try {
      const document = await getDocument(config);
      return { ...base, connected: true, title: document.title, tabTitle: document.tabTitle };
    } catch (error: any) {
      return { ...base, error: String(error?.message || error).slice(0, 500) };
    }
  },

  getDocument,

  async append(text: string, revisionId?: string, requestedTabId?: string) {
    const config = requireConfig();
    const document = await getDocument(config);
    const requiredRevisionId = revisionId || document.revisionId;
    const tab = resolveTargetTab(document, config.tabId, requestedTabId);
    const normalized = text.endsWith('\n') ? text : `${text}\n`;
    const request = { insertText: { text: normalized, endOfSegmentLocation: { segmentId: '', tabId: tab.id } } };
    const result = await batchUpdate(config, requiredRevisionId, [request]);
    return { appended: true, tabId: tab.id, tabTitle: tab.title, revisionId: result?.writeControl?.requiredRevisionId || result?.writeControl?.targetRevisionId };
  },

  async appendIfAbsent(text: string, dedupeText?: string, requestedTabId?: string) {
    const config = requireConfig();
    const document = await getDocument(config);
    const tab = resolveTargetTab(document, config.tabId, requestedTabId);
    const needle = (dedupeText || text).trim().toLocaleLowerCase();
    if (!needle) throw new Error('Text is required');
    if (tab.text.toLocaleLowerCase().includes(needle)) return { appended: false, reason: 'already-present', tabId: tab.id, tabTitle: tab.title, revisionId: document.revisionId };
    return this.append(text, document.revisionId, tab.id);
  },

  async replace(search: string, replacement: string, revisionId?: string, matchCase = true, requestedTabId?: string) {
    const config = requireConfig();
    const document = await getDocument(config);
    const tab = resolveTargetTab(document, config.tabId, requestedTabId);
    const haystack = matchCase ? tab.text : tab.text.toLocaleLowerCase();
    const needle = matchCase ? search : search.toLocaleLowerCase();
    if (!needle) throw new Error('Search text is required');
    if (!haystack.includes(needle)) return { replaced: false, reason: 'not-found', tabId: tab.id, tabTitle: tab.title, revisionId: document.revisionId };
    const request = { replaceAllText: { replaceText: replacement, containsText: { text: search, matchCase }, tabsCriteria: { tabIds: [tab.id] } } };
    const result = await batchUpdate(config, revisionId || document.revisionId, [request]);
    return { replaced: true, tabId: tab.id, tabTitle: tab.title, revisionId: result?.writeControl?.requiredRevisionId || result?.writeControl?.targetRevisionId };
  },

  async verifyWriteAccess(requestedTabId?: string) {
    const config = requireConfig();
    const document = await getDocument(config);
    const tabs = requestedTabId
      ? [resolveTargetTab(document, config.tabId, requestedTabId)]
      : document.tabs;
    if (tabs.length === 0) throw new Error('The configured document has no writable tabs');
    const requests = tabs.map(tab => {
      const marker = `__agent_forge_write_probe_${randomUUID()}__`;
      return { replaceAllText: { replaceText: marker, containsText: { text: marker, matchCase: true }, tabsCriteria: { tabIds: [tab.id] } } };
    });
    const result = await batchUpdate(config, document.revisionId, requests);
    const visibleChanges = (result?.replies || []).reduce((sum: number, reply: any) => sum + Number(reply?.replaceAllText?.occurrencesChanged || 0), 0);
    if (visibleChanges !== 0) throw new Error('Google Docs write probe unexpectedly matched document content');
    return { writable: true, tabsVerified: tabs.length, tabIds: tabs.map(tab => tab.id), visibleChanges: 0 };
  },

  getAgentInstructions(): string {
    const config = readConfig();
    return config ? buildGoogleDocsAgentInstructions(config, guiPort) : '';
  },
};
