import type { AgentProvider } from '../../shared/protocol';
import type { ProviderAuthSnapshot } from '../../shared/runtime-health';
import { CLAUDE_AUTH_COMPATIBILITY_FLOOR, inspectClaudeCredentialEnv } from './claude-precedence';

export const PROVIDER_INIT_DEADLINE_MS = 15_000;

export type AuthGateDecision =
  | { action: 'block'; snapshot: ProviderAuthSnapshot; userMessage: string }
  | { action: 'allow'; snapshot: ProviderAuthSnapshot; bootstrap: 'none' | 'required' };

export function decideAuthGate(
  snapshot: ProviderAuthSnapshot,
  env: Record<string, string | undefined> = process.env,
): AuthGateDecision {
  if (
    snapshot.state === 'reauthentication-required'
    || snapshot.state === 'provider-unavailable'
    || snapshot.state === 'misconfigured'
    || snapshot.reasonCode === 'cli-unsupported'
  ) {
    return { action: 'block', snapshot, userMessage: authGateUserMessage(snapshot.provider, snapshot, env) };
  }
  if (snapshot.state === 'degraded' || snapshot.state === 'checking') {
    return { action: 'allow', snapshot, bootstrap: 'required' };
  }
  return { action: 'allow', snapshot, bootstrap: 'none' };
}

export function authGateUserMessage(
  provider: AgentProvider,
  snapshot: ProviderAuthSnapshot,
  env: Record<string, string | undefined> = process.env,
): string {
  if (provider === 'codex') {
    return [
      'Codex is not ready for this turn.',
      snapshot.reasonCode === 'cli-missing'
        ? 'The Codex CLI was not found on PATH. Install Codex, then retry.'
        : 'Check the Codex CLI in a normal terminal, then retry this prompt.',
    ].join(' ');
  }

  switch (snapshot.reasonCode) {
    case 'cli-missing':
      return 'Claude Code was not found on PATH. Install the Claude CLI, then retry this prompt.';
    case 'cli-unsupported':
      return `This Claude CLI is older than the supported floor ${CLAUDE_AUTH_COMPATIBILITY_FLOOR}${snapshot.cliVersion ? ` (running ${snapshot.cliVersion})` : ''}. Update Claude Code, then retry.`;
    case 'precedence-named-conflict': {
      const names = inspectClaudeCredentialEnv(env).presentNames;
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
