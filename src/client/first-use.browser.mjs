import assert from 'node:assert/strict';

// Real UI and terminal processes, with provider turns intercepted throughout.
export async function checkFirstUseControls(browser, origin, project) {
  const failures = [];
  const flows = {
    async grids(page) {
      const checkGrid = async (columns, rows, panes, emptyButtons) => {
        await page.waitForFunction(({ columns, rows, panes, emptyButtons }) => {
          const grid = document.querySelector('.terminal-grid');
          return document.querySelector(`[aria-label="Use ${columns} grid column${columns === 1 ? '' : 's'}"]`)?.classList.contains('active')
            && document.querySelector(`[aria-label="Use ${rows} grid row${rows === 1 ? '' : 's'}"]`)?.classList.contains('active')
            && grid?.querySelectorAll('textarea').length === panes
            && grid?.querySelectorAll('.slot-add-btn').length === emptyButtons;
        }, { columns, rows, panes, emptyButtons }).catch(async error => {
          const actual = await page.evaluate(() => ({
            dimensions: [...document.querySelectorAll('.grid-btn.active')].map(button => button.textContent),
            panes: document.querySelectorAll('.terminal-grid textarea').length,
            emptyButtons: document.querySelectorAll('.terminal-grid .slot-add-btn').length,
          }));
          throw new Error(`Expected ${columns}×${rows}, ${panes} panes, ${emptyButtons} add buttons; got ${JSON.stringify(actual)}: ${error.message}`);
        });
      };
      await page.getByTitle('New Workspace', { exact: true }).click();
      await page.getByPlaceholder('e.g., Web app, Billing service, Mobile').fill('Automatic grid');
      await page.getByRole('button', { name: 'Browse for folder...', exact: true }).click();
      const picker = page.locator('.folder-browser');
      await page.waitForFunction(() => !document.querySelector('.folder-actions .btn-primary')?.disabled);
      await picker.getByPlaceholder('Filter or paste a path…').fill(project);
      await picker.getByPlaceholder('Filter or paste a path…').press('Enter');
      await page.waitForFunction(path => document.querySelector('.folder-path')?.textContent === path, project);
      await picker.getByRole('button', { name: 'Select', exact: true }).click();
      await page.getByRole('button', { name: 'Create Workspace', exact: true }).click();
      await page.locator('.workspace-item').filter({ hasText: 'Automatic grid' }).click();
      await checkGrid(1, 1, 0, 1);
      const addAgent = async (name, useEmptySlot = false) => {
        if (useEmptySlot) await page.locator('.slot-add-btn').click();
        else await page.getByRole('button', { name: 'Add agent to Automatic grid', exact: true }).click();
        await page.locator('.modal .form-input').first().fill(name);
        await page.getByRole('button', { name: 'Create Agent', exact: true }).click();
      };
      await addAgent('First', true);
      await checkGrid(1, 1, 1, 0);
      const geometry = await page.locator('.terminal-panel').evaluate(pane => ({
        pane: pane.getBoundingClientRect().width,
        grid: pane.parentElement.getBoundingClientRect().width,
      }));
      assert.ok(geometry.pane >= geometry.grid * 0.95, 'A single agent should use the full grid width');
      await addAgent('Second');
      await checkGrid(2, 1, 2, 0);
      await addAgent('Third');
      await checkGrid(2, 2, 3, 1);
      await page.reload();
      await checkGrid(2, 2, 3, 1);
      await addAgent('Fourth', true);
      await checkGrid(2, 2, 4, 0);
      await addAgent('Fifth');
      await checkGrid(3, 2, 5, 1);
      // Clicking an already active dimension still makes the layout manual.
      await page.getByRole('button', { name: 'Use 2 grid rows', exact: true }).click();
      await page.waitForFunction(() => window.firstUse.workspaces.find(ws => ws.name === 'Automatic grid')?.gridSizeManuallySet === true);
      await page.reload();
      await checkGrid(3, 2, 5, 1);
      await addAgent('Sixth', true);
      await checkGrid(3, 2, 6, 0);
      await addAgent('Sidebar only');
      await page.locator('.workspace-agent-chip').filter({ hasText: 'Sidebar only' }).waitFor();
      await checkGrid(3, 2, 6, 0);
      await page.getByRole('button', { name: 'Use 3 grid rows', exact: true }).click();
      await checkGrid(3, 3, 7, 1);
      const slots = () => page.locator('.terminal-grid > .terminal-panel').evaluateAll(panes =>
        panes.map(pane => pane.querySelector('.panel-title-name')?.textContent || ''));
      const beforeRemoval = await slots();
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Delete agent First', exact: true }).click();
      await checkGrid(3, 3, 6, 1);
      const afterRemoval = beforeRemoval.map(name => name === 'First' ? '' : name);
      assert.deepEqual(await slots(), afterRemoval, 'Removing an agent must preserve the remaining pane positions');
      await page.reload();
      await checkGrid(3, 3, 6, 1);
      assert.deepEqual(await slots(), afterRemoval, 'Reloading must preserve gaps in a manual grid');
    },
    async terminals(page) {
      await page.getByRole('button', { name: 'Use 3 grid columns', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Use 3 grid columns"]')?.classList.contains('active'));
      await page.getByRole('button', { name: 'Use 2 grid rows', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Use 2 grid rows"]')?.classList.contains('active'));
      const pane = page.locator('.terminal-panel').first();
      const run = pane.getByRole('button', { name: 'Run a command', exact: true });
      await run.click();
      const input = pane.getByRole('textbox', { name: 'Run a command in ' + project });
      const geometry = await input.evaluate(element => {
        const pane = element.closest('.terminal-panel');
        const rect = element.getBoundingClientRect();
        const panel = pane.getBoundingClientRect();
        const header = pane.querySelector('.panel-header').getBoundingClientRect();
        return { width: rect.width, paneWidth: panel.width, left: rect.left, right: rect.right,
          paneLeft: panel.left, paneRight: panel.right, top: rect.top, headerBottom: header.bottom };
      });
      assert.ok(geometry.width >= geometry.paneWidth * 0.9, 'Command input must span at least 90% of a pane in the 3×2 grid');
      assert.ok(geometry.left >= geometry.paneLeft && geometry.right <= geometry.paneRight, 'Command input must stay inside its pane');
      assert.ok(geometry.top >= geometry.headerBottom, 'Command input must sit below the header without overlapping');
      assert.equal(await input.evaluate(element => element.parentElement.previousElementSibling?.className), 'panel-header');
      assert.equal(await input.getAttribute('placeholder'), 'Run in …/' + project.replaceAll('\\', '/').split('/').pop());
      assert.ok((await input.getAttribute('title')).includes(project), 'Full working directory must remain available in the tooltip');
      assert.equal(await input.evaluate(element => element === document.activeElement), true);
      const theme = await input.evaluate(element => {
        const pane = element.closest('.terminal-panel');
        const input = getComputedStyle(element);
        const composer = getComputedStyle(pane.querySelector('.panel-input-wrapper'));
        return { background: input.backgroundColor, composerBackground: composer.backgroundColor,
          radius: input.borderRadius, composerRadius: composer.borderRadius,
          fontSize: input.fontSize, composerFontSize: getComputedStyle(pane.querySelector('textarea')).fontSize,
          outline: input.outlineStyle, shadow: input.boxShadow };
      });
      assert.equal(theme.background, theme.composerBackground);
      assert.equal(theme.radius, theme.composerRadius);
      assert.equal(theme.fontSize, theme.composerFontSize);
      assert.equal(theme.outline, 'none', 'Focused command input must not show the browser outline');
      assert.equal(theme.shadow, 'none');
      console.log(`PASS: command row at 1440×900, 3×2 grid (${Math.round(geometry.width)}px input / ${Math.round(geometry.paneWidth)}px pane)`);
      await input.fill('cancelled command');
      await input.press('Escape');
      assert.equal(await input.count(), 0);
      assert.equal(await page.evaluate(() => window.firstUse.sent.filter(m => m.type === 'create_terminal').length), 0);
      await run.click();
      await input.press('Enter'); // Empty commands do nothing.
      assert.equal(await input.count(), 1);
      await input.fill('   ');
      await input.press('Enter');
      assert.equal(await input.count(), 1);
      assert.equal(await page.evaluate(() => window.firstUse.sent.filter(m => m.type === 'create_terminal').length), 0);
      await input.fill(`node -e "console.log('forge-terminal-ok')"`);
      await input.press('Enter');
      await pane.locator('pre').filter({ hasText: 'forge-terminal-ok' }).waitFor();
      assert.equal(await input.count(), 0);
      // Also exercise the existing owned-process Kill path on a harmless timer.
      await run.click();
      await input.fill(`node -e "console.log('forge-terminal-running');setInterval(()=>{},1000)"`);
      await input.press('Enter');
      await pane.locator('pre').filter({ hasText: 'forge-terminal-running' }).waitFor();
      await pane.getByRole('button', { name: 'Kill', exact: true }).click();
      await pane.getByRole('button', { name: 'Kill', exact: true }).waitFor({ state: 'detached' });
      assert.equal(await page.locator('.terminal-panel').nth(1).locator('pre').filter({ hasText: 'forge-terminal-ok' }).count(), 0);
    },
    async folders(page) {
      await page.getByTitle('New Workspace', { exact: true }).click();
      await page.getByRole('button', { name: 'Browse for folder...', exact: true }).click();
      const picker = page.locator('.folder-browser');
      const input = picker.getByPlaceholder('Filter or paste a path…');
      await picker.getByRole('button', { name: 'Home', exact: true }).click();
      const home = await page.evaluate(() => window.__HOME_PATH);
      await page.waitForFunction(path => document.querySelector('.folder-path')?.textContent === path, home);
      await input.fill('proje');
      await picker.locator('.folder-item').filter({ hasText: 'projects' }).waitFor();
      await picker.getByText('↑ ..', { exact: true }).click();
      await page.waitForFunction(path => document.querySelector('.folder-path')?.textContent !== path, home);
      assert.equal(await input.inputValue(), '');
      await input.fill(project);
      await input.press('Enter');
      await page.waitForFunction(path => document.querySelector('.folder-path')?.textContent === path, project);
      await input.fill(project + '/does-not-exist');
      await input.press('Enter');
      await picker.getByRole('alert').waitFor();
      assert.equal(await picker.locator('.folder-path').textContent(), project);
      await input.fill('~/projects');
      await input.press('Enter');
      await page.waitForFunction(path => document.querySelector('.folder-path')?.textContent.replaceAll('\\', '/') === path.replaceAll('\\', '/') + '/projects', home);
      assert.equal(await picker.getByRole('alert').count(), 0);
      await picker.getByRole('button', { name: 'Select', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    },
    async modals(page) {
      const composer = page.locator('.terminal-panel textarea').first();
      await composer.click();
      await page.evaluate(() => {
        const agent = window.firstUse.agents.find(a => a.id === 'demo-0');
        window.firstUse.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
          type: 'agent_updated', agent: { ...agent, status: 'working' },
        }) }));
      });
      await page.getByText('Stop turn', { exact: true }).waitFor();
      for (const open of [
        () => page.getByTitle('Settings', { exact: true }).click(),
        () => page.getByTitle('New Workspace', { exact: true }).click(),
        () => page.keyboard.press('Control+n'),
      ]) {
        await open();
        await page.locator('.modal-overlay').waitFor();
        await page.keyboard.press('Escape');
        await page.locator('.modal-overlay').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => window.firstUse.sent.filter(m => m.type === 'stop_agent').length), 0,
          'Closing a modal must not stop the focused turn');
      }
      await composer.click();
      await composer.press('Escape');
      assert.equal(await page.evaluate(() => window.firstUse.sent.filter(m => m.type === 'stop_agent').length), 1,
        'Escape still stops the focused turn when no modal is open');
    },
  };
  for (const [name, check] of Object.entries(flows)) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const Original = window.WebSocket;
      window.firstUse = { sent: [], agents: [], workspaces: [] };
      window.WebSocket = class extends Original {
        constructor(...args) {
          super(...args);
          window.firstUse.socket = this;
          this.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.type === 'agents_list') window.firstUse.agents = message.agents;
            if (message.type === 'workspaces_list') window.firstUse.workspaces = message.workspaces;
            if (message.type === 'workspace_updated') window.firstUse.workspaces = window.firstUse.workspaces.map(ws => ws.id === message.workspace.id ? message.workspace : ws);
            if (message.type === 'workspace_created') window.firstUse.workspaces.push(message.workspace);
          });
        }
        send(data) {
          const message = JSON.parse(data);
          window.firstUse.sent.push(message);
          if (!['send_message', 'stop_agent'].includes(message.type)) super.send(data);
        }
      };
    });
    await page.route('**/api/ports', route => route.fulfill({ json: { ports: [] } }));
    try {
      await page.goto(origin);
      await page.getByText('Search is ready', { exact: true }).waitFor();
      await check(page);
      assert.deepEqual(errors, []);
      console.log('PASS: first-use ' + name);
    } catch (error) {
      failures.push(name + ': ' + error.stack);
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(failures, [], 'First-use browser regressions');
}
