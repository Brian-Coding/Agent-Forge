import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = source.indexOf('      const handleSubmit = async () => {');
const end = source.indexOf('      const handleKeyDown =', start);
if (start < 0 || end < start) throw new Error('Could not locate the composer submit handler');

// Execute the shipped handler, controlling the frame and upload boundaries at
// which the user can move focus. No provider, network, or real home is involved.
function composer(options: { imageUpload?: () => Promise<void> } = {}) {
  const body = {};
  const document = { body, activeElement: body };
  const input = { focus: () => { document.activeElement = input; } };
  const frames: Array<() => void> = [];
  const sends: string[] = [];
  const content = { scrollTop: 0, scrollHeight: 200 };
  const dependencies = {
    agent: { id: 'agent-a' }, uploadProgress: null, input: 'Inspect the fixture.',
    document, inputRef: { current: input }, contentRef: { current: content },
    pendingImagesRef: { current: options.imageUpload ? [{ previewUrl: 'blob:fixture' }] : [] },
    onSendMessage: (text: string) => sends.push(text),
    onSendImages: options.imageUpload,
    setImageUploadError: () => {}, setUploadProgress: () => {}, replacePendingImages: () => {},
    setInputHistory: () => {}, setHistoryIdx: () => {}, setInput: () => {}, setAutoScrollEnabled: () => {},
    URL: { revokeObjectURL: () => {} },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  };
  const submit = new Function(...Object.keys(dependencies), `${source.slice(start, end)}; return handleSubmit;`)(
    ...Object.values(dependencies),
  ) as () => Promise<void>;
  input.focus();
  return { document, input, sends, content, submit, flush: () => frames.splice(0).forEach(callback => callback()) };
}

test('sending in one composer cannot steal focus from another before the next frame', async () => {
  const first = composer();
  await first.submit();
  const secondComposer = {};
  first.document.activeElement = secondComposer;
  first.flush();
  expect(first.document.activeElement).toBe(secondComposer);
  expect(first.sends).toEqual(['Inspect the fixture.']);
  expect(first.content.scrollTop).toBe(first.content.scrollHeight);
});

test('sending preserves focus moved to another control in the same pane', async () => {
  const panel = composer();
  await panel.submit();
  const searchControl = {};
  panel.document.activeElement = searchControl;
  panel.flush();
  expect(panel.document.activeElement).toBe(searchControl);
});

test('keyboard and Send button submissions restore the composer when focus has not moved', async () => {
  for (const control of ['keyboard', 'button', 'disabled-button']) {
    const panel = composer();
    if (control !== 'keyboard') panel.document.activeElement = {};
    await panel.submit();
    // A Send button disabled by the cleared draft relinquishes browser focus.
    if (control === 'disabled-button') panel.document.activeElement = panel.document.body;
    panel.flush();
    expect(panel.document.activeElement).toBe(panel.input);
    expect(panel.sends).toHaveLength(1);
  }
});

test('finishing an image upload cannot steal focus moved while the upload was pending', async () => {
  let finish!: () => void;
  const panel = composer({ imageUpload: () => new Promise<void>(resolve => { finish = resolve; }) });
  const sending = panel.submit();
  const secondComposer = {};
  panel.document.activeElement = secondComposer;
  finish();
  await sending;
  panel.flush();
  expect(panel.document.activeElement).toBe(secondComposer);
});

test('finishing an image upload restores focus relinquished by the disabled composer', async () => {
  let finish!: () => void;
  const panel = composer({ imageUpload: () => new Promise<void>(resolve => { finish = resolve; }) });
  const sending = panel.submit();
  panel.document.activeElement = panel.document.body;
  finish();
  await sending;
  panel.flush();
  expect(panel.document.activeElement).toBe(panel.input);
});
