import { randomUUID } from 'node:crypto';
import type { AgentProvider, AuthRecoveryIncident, ServerMessage } from '../../shared/protocol';
import type { ProviderAuthReasonCode, ProviderAuthState } from '../../shared/runtime-health';
import { healthContainsSecretLikeValue } from '../../shared/runtime-health';
import { commandSession } from '../services/command-session';
import { currentAuthCoordinator } from './provider-auth-coordinator';
import { authRecoveryAction, authRecoveryCopy } from './recovery-copy';

export interface RecordAuthRecoveryInput {
  agentId: string;
  provider: AgentProvider;
  messageId: string;
  reasonCode: ProviderAuthReasonCode;
  state: ProviderAuthState;
  cliVersion?: string;
  env?: Record<string, string | undefined>;
  retrySafe: boolean;
  sideEffectRisk: boolean;
  automaticRetryUsed: boolean;
}

export type AuthRetryDecision =
  | { ok: true; incident: AuthRecoveryIncident }
  | { ok: false; reasonCode: string; userMessage: string };

export interface AuthRecoveryStoreOptions {
  now?: () => number;
  onChange?: (snapshot: Extract<ServerMessage, { type: 'auth_recovery' }>) => void;
}

export function createAuthRecoveryStore(options: AuthRecoveryStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const incidents = new Map<string, AuthRecoveryIncident>();

  const snapshot = (): Extract<ServerMessage, { type: 'auth_recovery' }> => ({
    type: 'auth_recovery',
    serverSessionId: commandSession.serverSessionId,
    incidents: [...incidents.values()]
      .filter(incident => !incident.resolvedAt)
      .map(incident => ({ ...incident })),
  });

  const notify = () => {
    const next = snapshot();
    if (healthContainsSecretLikeValue(next)) return;
    options.onChange?.(next);
  };

  return {
    record(input: RecordAuthRecoveryInput): AuthRecoveryIncident | null {
      const copy = authRecoveryCopy({
        provider: input.provider,
        reasonCode: input.reasonCode,
        cliVersion: input.cliVersion,
        env: input.env,
        automaticRetryUsed: input.automaticRetryUsed,
        sideEffectRisk: input.sideEffectRisk,
      });
      const incident: AuthRecoveryIncident = {
        incidentId: randomUUID(),
        agentId: input.agentId,
        provider: input.provider,
        messageId: input.messageId,
        reasonCode: input.reasonCode,
        state: input.state,
        recoveryAction: copy.recoveryAction,
        userMessage: copy.userMessage,
        retrySafe: input.retrySafe,
        sideEffectRisk: input.sideEffectRisk,
        automaticRetryUsed: input.automaticRetryUsed,
        createdAt: now(),
      };
      if (healthContainsSecretLikeValue(incident)) return null;
      for (const existing of incidents.values()) {
        if (existing.agentId === input.agentId && existing.messageId === input.messageId && !existing.resolvedAt) {
          existing.resolvedAt = now();
        }
      }
      incidents.set(incident.incidentId, incident);
      notify();
      return incident;
    },

    async checkAgain(agentId: string, provider: AgentProvider) {
      currentAuthCoordinator().invalidate(provider);
      const probed = await currentAuthCoordinator().probe(provider);
      const copy = probed.state === 'verified' || probed.state === 'configured-unverified'
        ? {
          userMessage: provider === 'codex'
            ? 'Codex now looks configured. Retry the preserved prompt.'
            : 'Claude now reports a configured login. Retry the preserved prompt.',
        }
        : authRecoveryCopy({
          provider,
          reasonCode: probed.reasonCode,
          cliVersion: probed.cliVersion,
        });
      for (const incident of incidents.values()) {
        if (incident.agentId !== agentId || incident.provider !== provider || incident.resolvedAt) continue;
        incident.lastCheckedAt = now();
        incident.state = probed.state;
        incident.reasonCode = probed.reasonCode;
        incident.recoveryAction = probed.recoveryAction ?? authRecoveryAction(probed.reasonCode);
        incident.userMessage = copy.userMessage;
      }
      notify();
      return probed;
    },

    canRetry(agentId: string, incidentId: string, confirmSideEffects: boolean): AuthRetryDecision {
      const incident = incidents.get(incidentId);
      if (!incident || incident.resolvedAt || incident.agentId !== agentId) {
        return { ok: false, reasonCode: 'auth-recovery-missing', userMessage: 'That preserved prompt is no longer waiting for recovery.' };
      }
      if (incident.sideEffectRisk && !confirmSideEffects) {
        return {
          ok: false,
          reasonCode: 'side-effect-review-required',
          userMessage: 'This turn may already have done work. Confirm Retry preserved prompt if you accept a possible duplicate action.',
        };
      }
      return { ok: true, incident };
    },

    resolveAgent(agentId: string) {
      let changed = false;
      for (const incident of incidents.values()) {
        if (incident.agentId === agentId && !incident.resolvedAt) {
          incident.resolvedAt = now();
          changed = true;
        }
      }
      if (changed) notify();
    },

    clearAgent(agentId: string) {
      let changed = false;
      for (const [id, incident] of incidents) {
        if (incident.agentId === agentId) {
          incidents.delete(id);
          changed = true;
        }
      }
      if (changed) notify();
    },

    get(incidentId: string): AuthRecoveryIncident | undefined {
      return incidents.get(incidentId);
    },

    openForAgent(agentId: string): AuthRecoveryIncident[] {
      return [...incidents.values()].filter(incident => incident.agentId === agentId && !incident.resolvedAt);
    },

    snapshot,
  };
}

export type AuthRecoveryStore = ReturnType<typeof createAuthRecoveryStore>;

type ChangeListener = (snapshot: Extract<ServerMessage, { type: 'auth_recovery' }>) => void;
let changeListener: ChangeListener | undefined;

export function setAuthRecoveryListener(listener: ChangeListener): void {
  changeListener = listener;
}

export const authRecoveryStore: AuthRecoveryStore = (globalThis as any).__authRecoveryStore ??= createAuthRecoveryStore({
  onChange: snapshot => changeListener?.(snapshot),
});
(globalThis as any).__authRecoveryStore = authRecoveryStore;
