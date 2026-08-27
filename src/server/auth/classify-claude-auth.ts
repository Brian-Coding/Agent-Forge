import type {
  ProviderAuthEvidence,
  ProviderAuthReasonCode,
  ProviderAuthRecoveryAction,
  ProviderAuthState,
  ProviderCredentialMode,
} from '../../shared/runtime-health';

export interface ClaudeAuthProbeInput {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  missing?: boolean;
  kind?: 'auth-status' | 'turn-output';
}

export interface ClaudeAuthClassification {
  state: ProviderAuthState;
  credentialMode: ProviderCredentialMode;
  evidence: ProviderAuthEvidence;
  reasonCode: ProviderAuthReasonCode;
  recoveryAction?: ProviderAuthRecoveryAction;
}

export function classifyClaudeAuthOutput(input: ClaudeAuthProbeInput): ClaudeAuthClassification {
  if (input.missing) {
    return {
      state: 'provider-unavailable',
      credentialMode: 'unknown',
      evidence: 'none',
      reasonCode: 'cli-missing',
      recoveryAction: 'inspect-provider',
    };
  }
  if (input.timedOut) {
    return {
      state: 'degraded',
      credentialMode: 'unknown',
      evidence: 'none',
      reasonCode: 'cli-timeout',
      recoveryAction: 'inspect-provider',
    };
  }

  const stdout = input.stdout ?? '';
  const stderr = input.stderr ?? '';
  const text = `${stdout}\n${stderr}`;
  const kind = input.kind ?? inferKind(stdout);

  if (kind === 'turn-output') return classifyTurnOutput(text);
  return classifyAuthStatus(stdout, input.exitCode ?? null);
}

function inferKind(stdout: string): 'auth-status' | 'turn-output' {
  const trimmed = stdout.trim();
  if (!trimmed) return 'auth-status';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'auth-status';
  return 'turn-output';
}

function classifyAuthStatus(stdout: string, exitCode: number | null): ClaudeAuthClassification {
  let status: any = null;
  try {
    status = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    return {
      state: 'degraded',
      credentialMode: 'unknown',
      evidence: 'cli-status',
      reasonCode: 'cli-malformed',
      recoveryAction: 'inspect-provider',
    };
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return {
      state: 'degraded',
      credentialMode: 'unknown',
      evidence: 'cli-status',
      reasonCode: 'cli-malformed',
      recoveryAction: 'inspect-provider',
    };
  }

  const credentialMode = credentialModeFromStatus(status);
  if (status.loggedIn === true) {
    return {
      state: 'configured-unverified',
      credentialMode,
      evidence: 'cli-status',
      reasonCode: 'cli-logged-in',
      recoveryAction: 'check-again',
    };
  }
  if (status.loggedIn === false || exitCode === 1) {
    return {
      state: 'reauthentication-required',
      credentialMode,
      evidence: 'cli-status',
      reasonCode: 'cli-not-logged-in',
      recoveryAction: 'login',
    };
  }
  return {
    state: 'degraded',
    credentialMode,
    evidence: 'cli-status',
    reasonCode: 'cli-malformed',
    recoveryAction: 'inspect-provider',
  };
}

function classifyTurnOutput(text: string): ClaudeAuthClassification {
  if (/oauth access token has expired/i.test(text) || /please re-authenticate/i.test(text)) {
    return {
      state: 'reauthentication-required',
      credentialMode: 'subscription-oauth',
      evidence: 'provider-error',
      reasonCode: 'access-token-expired',
      recoveryAction: 'check-again',
    };
  }
  if (/oauth.*revoked|login has been revoked/i.test(text)) {
    return {
      state: 'reauthentication-required',
      credentialMode: 'subscription-oauth',
      evidence: 'provider-error',
      reasonCode: 'oauth-revoked',
      recoveryAction: 'login',
    };
  }
  if (/401/.test(text) && /invalid api key/i.test(text)) {
    return {
      state: 'misconfigured',
      credentialMode: 'api-key',
      evidence: 'provider-error',
      reasonCode: 'precedence-named-conflict',
      recoveryAction: 'fix-precedence',
    };
  }
  if (/401/.test(text)) {
    return {
      state: 'reauthentication-required',
      credentialMode: 'unknown',
      evidence: 'provider-error',
      reasonCode: 'provider-401',
      recoveryAction: 'login',
    };
  }
  return {
    state: 'degraded',
    credentialMode: 'unknown',
    evidence: 'provider-error',
    reasonCode: 'provider-error',
    recoveryAction: 'inspect-provider',
  };
}

function credentialModeFromStatus(status: { authMethod?: unknown; apiProvider?: unknown }): ProviderCredentialMode {
  const method = String(status.authMethod || '').toLowerCase();
  const provider = String(status.apiProvider || '').toLowerCase();
  const joined = `${method} ${provider}`;
  if (joined.includes('helper')) return 'api-key-helper';
  if (joined.includes('setup') || joined.includes('oauth_token')) return 'setup-token';
  if (joined.includes('auth-token') || joined.includes('authtoken') || joined.includes('auth_token')) return 'auth-token';
  if (joined.includes('api-key') || joined.includes('apikey') || joined.includes('api_key')) return 'api-key';
  if (joined.includes('cloud')) return 'cloud';
  if (joined.includes('oauth') || joined.includes('subscription')) return 'subscription-oauth';
  return 'unknown';
}
