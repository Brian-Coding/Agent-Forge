import { expect, test } from 'bun:test';
import { AtlasAnswerValidationError } from '../services/atlas-query-result';
import { AtlasQueryBusyError, atlasQueryService } from '../services/atlas-query.service';
import { vercelIntegrationService } from '../services/vercel-integration.service';
import { handleAskAtlas } from './atlas.routes';
import { handleChatImage, handleChatImageUpload } from './chat-image.routes';
import { handleHarnessInstructions } from './harness.routes';
import { handleVercelIntegration } from './integrations.routes';
import { handleGetModels } from './models.routes';

test('read-only harness and model routes return bounded structured responses and preserve refresh intent', async () => {
  const harness = await handleHarnessInstructions().json() as any;
  expect(harness.sections.map((section: any) => section.id)).toContain('guardrails');
  expect(harness.assemblyOrder).toBeArray();

  const refreshCalls: boolean[] = [];
  const models = await handleGetModels(
    new Request('http://localhost/api/models?refresh=1'),
    async force => {
      refreshCalls.push(force ?? false);
      return { claude: { kind: 'claude' }, codex: { kind: 'codex' } } as any;
    },
  );
  expect(models.status).toBe(200);
  expect(refreshCalls).toEqual([true]);
  expect((await models.json() as any).providers.codex.kind).toBe('codex');

  const failed = await handleGetModels(
    new Request('http://localhost/api/models'),
    async () => { throw new Error('catalog unavailable'); },
  );
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: 'catalog unavailable' });
});

test('Vercel integration route separates read-only status from explicit configuration and maps failures', async () => {
  const originalGetStatus = vercelIntegrationService.getStatus;
  const originalConfigure = vercelIntegrationService.configure;
  const calls: string[] = [];
  vercelIntegrationService.getStatus = async () => {
    calls.push('status');
    return { ready: false, endpoint: 'fixture' } as any;
  };
  vercelIntegrationService.configure = async () => {
    calls.push('configure');
    return { ready: true, endpoint: 'fixture' } as any;
  };

  try {
    expect(await (await handleVercelIntegration(new Request('http://localhost/api/integrations/vercel'))).json())
      .toMatchObject({ ready: false });
    expect(await (await handleVercelIntegration(new Request('http://localhost/api/integrations/vercel', { method: 'POST' }))).json())
      .toMatchObject({ ready: true });
    expect(calls).toEqual(['status', 'configure']);

    vercelIntegrationService.getStatus = async () => { throw new Error('CLI check failed'); };
    const failed = await handleVercelIntegration(new Request('http://localhost/api/integrations/vercel'));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'CLI check failed' });
  } finally {
    vercelIntegrationService.getStatus = originalGetStatus;
    vercelIntegrationService.configure = originalConfigure;
  }
});

test('Ask Atlas route enforces body bounds and maps busy, grounding, and provider failures distinctly', async () => {
  const originalAsk = atlasQueryService.ask;
  const request = () => new Request('http://localhost/api/atlas/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'workspace-1', question: 'Where is Home?' }),
  });

  try {
    expect((await handleAskAtlas(new Request('http://localhost/api/atlas/ask', { method: 'POST', body: '{}' }))).status).toBe(400);
    expect((await handleAskAtlas(new Request('http://localhost/api/atlas/ask', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'workspace-1', question: 'x'.repeat(9_000) }),
    }))).status).toBe(413);

    atlasQueryService.ask = async () => { throw new AtlasQueryBusyError(); };
    expect((await handleAskAtlas(request())).status).toBe(409);

    atlasQueryService.ask = async () => { throw new AtlasAnswerValidationError(['invented surface ID']); };
    const ungrounded = await handleAskAtlas(request());
    expect(ungrounded.status).toBe(422);
    expect((await ungrounded.json() as any).validationErrors).toEqual(['invented surface ID']);

    atlasQueryService.ask = async () => { throw new Error('provider disconnected'); };
    expect(await (await handleAskAtlas(request())).json()).toEqual({ error: 'provider disconnected' });

    atlasQueryService.ask = async () => ({ answer: 'Home is `surface.home`.', citations: ['surface.home'] } as any);
    const success = await handleAskAtlas(request());
    expect(success.status).toBe(200);
    expect((await success.json() as any).citations).toEqual(['surface.home']);
  } finally {
    atlasQueryService.ask = originalAsk;
  }
});

test('chat-image routes reject missing agents and unsafe paths before filesystem access', async () => {
  const missingId = await handleChatImageUpload(new Request('http://localhost/api/chat-image', {
    method: 'POST',
    body: new Uint8Array([1]),
  }));
  expect(missingId.status).toBe(400);

  const missingAgent = await handleChatImageUpload(new Request('http://localhost/api/chat-image?agentId=does-not-exist', {
    method: 'POST',
    body: new Uint8Array([1]),
  }));
  expect(missingAgent.status).toBe(404);

  expect(handleChatImage(new Request('http://localhost/api/chat-image')).status).toBe(400);
  expect(handleChatImage(new Request('http://localhost/api/chat-image?path=..%2F..%2Fsecret.png')).status).toBe(400);
});
