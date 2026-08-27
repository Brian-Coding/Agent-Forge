import type { AgentProvider } from '../../shared/protocol';
import type { ProviderAuthReasonCode, ProviderAuthRecoveryAction } from '../../shared/runtime-health';
import { CLAUDE_AUTH_COMPATIBILITY_FLOOR, inspectClaudeCredentialEnv } from './claude-precedence';

export interface AuthRecoveryCopyInput {
  provider: AgentProvider;
  reasonCode: ProviderAuthReasonCode;
  cliVersion?: string;
  env?: Record<string, string | undefined>;
  automaticRetryUsed?: boolean;
  sideEffectRisk?: boolean;
}

export interface AuthRecoveryCopy {
  title: string;
  userMessage: string;
  recoveryAction: ProviderAuthRecoveryAction;
}

export function authRecoveryAction(reasonCode: ProviderAuthReasonCode): ProviderAuthRecoveryAction {
  switch (reasonCode) {
    case 'cli-unsupported':
      return 'update-cli';
    case 'precedence-named-conflict':
      return 'fix-precedence';
    case 'cli-missing':
      return 'inspect-provider';
    case 'cli-not-logged-in':
    case 'refresh-token-expired':
    case 'oauth-revoked':
    case 'provider-401':
    case 'access-token-expired':
      return 'login';
    default:
      return 'check-again';
  }
}

export function authRecoveryCopy(input: AuthRecoveryCopyInput): AuthRecoveryCopy {
  const recoveryAction = authRecoveryAction(input.reasonCode);
  const title = input.provider === 'codex' ? 'Codex authentication' : 'Claude authentication';
  const parts = [baseRecoveryCopy(input)];
  if (input.automaticRetryUsed) {
    parts.push('Agent Forge retried once and it failed again.');
  } else if (input.sideEffectRisk) {
    parts.push('This turn may already have done work, so it was not retried automatically. Retry the preserved prompt only if you accept a possible duplicate action.');
  }
  parts.push('Use Check again, then Retry preserved prompt.');
  return {
    title,
    userMessage: parts.join(' '),
    recoveryAction,
  };
}

function baseRecoveryCopy(input: AuthRecoveryCopyInput): string {
  if (input.provider === 'codex') {
    if (input.reasonCode === 'cli-missing') {
      return 'The Codex CLI was not found on PATH. Install Codex, then retry this prompt.';
    }
    if (input.reasonCode === 'access-token-expired' || input.reasonCode === 'provider-401') {
      return 'Codex login expired mid-turn. Sign in with the Codex CLI in a normal terminal, then retry this prompt.';
    }
    return 'Codex is not ready for this turn. Check the Codex CLI in a normal terminal, then retry this prompt.';
  }

  switch (input.reasonCode) {
    case 'cli-missing':
      return 'Claude Code was not found on PATH. Install the Claude CLI, then retry this prompt.';
    case 'cli-unsupported':
      return `This Claude CLI is older than the supported floor ${CLAUDE_AUTH_COMPATIBILITY_FLOOR}${input.cliVersion ? ` (running ${input.cliVersion})` : ''}. Update Claude Code, then retry.`;
    case 'precedence-named-conflict': {
      const names = inspectClaudeCredentialEnv(input.env ?? {}).presentNames;
      const named = names.length > 0 ? names.join(', ') : 'ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN';
      return `Claude has more than one named credential in the environment (${named}). Unset the unused names so one method is active, then retry. Values are not shown.`;
    }
    case 'oauth-revoked':
    case 'provider-401':
    case 'cli-not-logged-in':
    case 'refresh-token-expired':
      return 'Claude Code is not authenticated. Run `claude auth login` in a normal terminal, then retry this prompt.';
    case 'access-token-expired':
      return 'Claude reported an expired access token. Run `claude auth login` in a normal terminal if a retry still fails.';
    default:
      return 'Claude cannot start this turn until authentication is fixed. Run `claude auth status` in a normal terminal, then retry.';
  }
}
