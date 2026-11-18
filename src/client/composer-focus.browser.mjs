import assert from 'node:assert/strict';

export async function checkComposerFocus(page) {
  const composers = page.locator('.terminal-panel textarea');
  const firstPrompt = 'Inspect the fictional search fixture.';
  const secondPrompt = 'Verify the fictional search fixture.';
  await composers.nth(0).fill(firstPrompt);
  await page.evaluate(() => {
    const requestFrame = window.requestAnimationFrame;
    const send = WebSocket.prototype.send;
    const frames = [];
    const messages = [];
    // Hold the post-submit frame until the user has moved to the other pane.
    // Intercept only turn submissions: this fixture must never launch a CLI.
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    WebSocket.prototype.send = function(data) {
      const message = JSON.parse(data);
      if (message.type === 'send_message') messages.push(message);
      else send.call(this, data);
    };
    window.composerFocusTest = {
      messages,
      flush() { frames.splice(0).forEach(callback => callback(performance.now())); },
      restore() { window.requestAnimationFrame = requestFrame; WebSocket.prototype.send = send; },
    };
  });
  try {
    await composers.nth(0).press('Enter');
    await composers.nth(1).fill(secondPrompt);
    await page.evaluate(() => window.composerFocusTest.flush());
    assert.equal(await composers.nth(1).evaluate(element => element === document.activeElement), true,
      'Pane 0 must not steal pane 1 focus when its deferred submit callback runs');
    // Use the actual keyboard target; locator.press would refocus the textarea
    // and could conceal the very race this regression is exercising.
    await page.keyboard.press('Enter');
    const messages = await page.evaluate(() => window.composerFocusTest.messages);
    assert.deepEqual(messages.map(({ agentId, content }) => ({ agentId, content })), [
      { agentId: 'demo-0', content: firstPrompt },
      { agentId: 'demo-1', content: secondPrompt },
    ]);
    assert.equal(new Set(messages.map(message => message.requestId)).size, 2);
    assert.equal(await composers.nth(0).inputValue(), '');
    assert.equal(await composers.nth(1).inputValue(), '');
  } finally {
    await page.evaluate(() => {
      window.composerFocusTest.restore();
      window.composerFocusTest.flush();
      delete window.composerFocusTest;
    });
  }
}
