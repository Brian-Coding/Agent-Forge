export const AUTH_CONTRACT_VERSION = 1;

export type RuntimeDriftState = 'current' | 'restart-required' | 'unknown';

export type ProviderAuthState =
  | 'unknown'
  | 'checking'
  | 'configured-unverified'
  | 'verified'
  | 'reauthentication-required'
  | 'misconfigured'
  | 'provider-unavailable'
  | 'degraded';

export type ProviderAuthEvidence =
  | 'cli-status'
  | 'provider-init'
  | 'turn-success'
  | 'provider-error'
  | 'configuration'
  | 'none';

export type ProviderCredentialMode =
  | 'subscription-oauth'
  | 'setup-token'
  | 'api-key'
  | 'auth-token'
  | 'api-key-helper'
  | 'cloud'
  | 'unknown';

export type ProviderAuthRecoveryAction =
  | 'check-again'
  | 'login'
  | 'fix-precedence'
  | 'update-cli'
  | 'inspect-provider';

export const PROVIDER_AUTH_REASON_CODES = [
  'not-probed',
  'cli-logged-in',
  'cli-not-logged-in',
  'cli-missing',
  'cli-timeout',
  'cli-malformed',
  'cli-unsupported',
  'access-token-expired',
  'refresh-token-expired',
  'oauth-revoked',
  'precedence-named-conflict',
  'named-credential-present',
  'provider-401',
  'provider-error',
] as const;

export type ProviderAuthReasonCode = (typeof PROVIDER_AUTH_REASON_CODES)[number];

export interface RuntimeProviderIdentity {
  provider: 'claude' | 'codex';
  cliName: string;
  available: boolean;
  cliVersion?: string;
}

export interface RuntimeSourceIdentity {
  commit?: string;
  dirty: boolean;
}

export interface RuntimeManifest {
  contractVersion: number;
  serverSessionId: string;
  startedAt: number;
  bunVersion: string;
  source: RuntimeSourceIdentity;
  runningFingerprint: string;
  onDiskFingerprint?: string;
  drift: RuntimeDriftState;
  providers: RuntimeProviderIdentity[];
}

export interface ProviderAuthSnapshot {
  provider: 'claude' | 'codex';
  state: ProviderAuthState;
  credentialMode: ProviderCredentialMode;
  evidence: ProviderAuthEvidence;
  reasonCode: ProviderAuthReasonCode;
  checkedAt: number;
  verifiedAt?: number;
  cliVersion?: string;
  recoveryAction?: ProviderAuthRecoveryAction;
}

export interface RuntimeHealth {
  contractVersion: number;
  runtime: RuntimeManifest;
  auth: ProviderAuthSnapshot[];
}

const SECRET_LIKE = [
  /sk-ant-[a-z0-9_-]+/i,
  /sk-proj-[a-z0-9_-]+/i,
  /ghp_[a-z0-9]+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ANTHROPIC_(?:API_KEY|AUTH_TOKEN)=/i,
  /CLAUDE_CODE_OAUTH_TOKEN=/i,
  /OPENAI_API_KEY=/i,
];

export function healthContainsSecretLikeValue(value: unknown): boolean {
  const text = JSON.stringify(value);
  return SECRET_LIKE.some(pattern => pattern.test(text));
}

export function unprobedAuthSnapshot(
  provider: 'claude' | 'codex',
  checkedAt: number,
  cliVersion?: string,
): ProviderAuthSnapshot {
  return {
    provider,
    state: 'unknown',
    credentialMode: 'unknown',
    evidence: 'none',
    reasonCode: 'not-probed',
    checkedAt,
    ...(cliVersion ? { cliVersion } : {}),
  };
}
