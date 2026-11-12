import { expect, test } from 'bun:test';
import { handleChatImage, handleChatImageUpload } from './chat-image.routes';
import { handleHarnessInstructions } from './harness.routes';
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
