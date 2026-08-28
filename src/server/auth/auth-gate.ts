import type { AgentProvider } from '../../shared/protocol';
import type { ProviderAuthSnapshot } from '../../shared/runtime-health';
import { authRecoveryCopy } from './recovery-copy';

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
  return authRecoveryCopy({
    provider,
    reasonCode: snapshot.reasonCode,
    cliVersion: snapshot.cliVersion,
    env,
  }).userMessage;
}
