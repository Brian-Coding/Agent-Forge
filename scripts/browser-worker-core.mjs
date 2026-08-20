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

/**
 * Share one in-flight operation per key. Rejections are visible to every
 * waiter but never poison a later retry, and unrelated keys remain parallel.
 */
export function singleFlight(inFlight, key, operation) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(operation);
  inFlight.set(key, pending);
  void pending.finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }).catch(() => {});
  return pending;
}

/** Reject on schedule even when timeout cleanup itself hangs. */
export async function withOperationTimeout(operation, timeoutMs, label, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        Promise.resolve(onTimeout?.()).catch(() => {});
      } finally {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

