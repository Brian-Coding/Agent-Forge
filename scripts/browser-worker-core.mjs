/**
 * Pure helpers shared by the Playwright worker and its contract tests.
 * Keeping these free of Playwright/process side effects makes the most
 * failure-prone browser semantics cheap to test.
 */

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

export function normalizeBrowserSessionId(value) {
  if (value == null || value === '') return 'default';
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) {
    throw new Error('browserSessionId must be 1-96 letters, numbers, underscores, or dashes');
  }
  return value;
}

export function browserSessionKey(workspaceId, browserSessionId) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new Error('workspaceId required');
  }
  return JSON.stringify([workspaceId, normalizeBrowserSessionId(browserSessionId)]);
}

/**
 * Compile user JavaScript without executing it to decide whether it is an
 * expression or a statement body. The old runtime try/catch fallback executed
 * a valid-but-throwing expression twice. This compiler chooses one form first,
 * so every script executes at most once.
 */
export function compileEvaluationScript(script) {
  if (typeof script !== 'string' || script.trim().length === 0) {
    throw new Error('script (non-empty string) required');
  }

  try {
    // Parse only. `new Function` does not run the supplied script.
    new Function(`return (${script}\n);`);
    return `(async () => (${script}\n))()`;
  } catch {
    // Not an expression. Validate it as an async function body so `return`
    // and `await` both work for multi-statement scripts.
    try {
      new Function(`return (async () => {\n${script}\n});`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid evaluation script: ${message}`);
    }
    return `(async () => {\n${script}\n})()`;
  }
}

