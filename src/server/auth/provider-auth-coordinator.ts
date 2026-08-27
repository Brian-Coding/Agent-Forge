import type { AgentProvider } from '../../shared/protocol';
import type { ProviderAuthSnapshot, RuntimeProviderIdentity } from '../../shared/runtime-health';
import { healthContainsSecretLikeValue, unprobedAuthSnapshot } from '../../shared/runtime-health';
import { inspectClaudeCredentialEnv } from './claude-precedence';
import { classifyClaudeAuthOutput, type ClaudeAuthProbeInput } from './classify-claude-auth';
import { createClaudeAuthProbe, createCodexAuthProbe, type ProviderAuthProbe } from './provider-auth-probe';

export const AUTH_SHADOW_CACHE_TTL_MS = 30_000;

export type LegacyAuthClass =
  | 'skip'
  | 'env-bypass'
  | 'refresh-expired'
  | 'logged-out'
  | 'inconclusive-allow'
  | 'cli-allow'
  | 'block';

export interface LegacyAuthObservation {
  outcome: 'allow' | 'block';
  class: LegacyAuthClass;
}

export interface AuthShadowComparison {
  provider: AgentProvider;
  agree: boolean;
  classifierState: ProviderAuthSnapshot['state'];
  classifierReason: ProviderAuthSnapshot['reasonCode'];
  legacyOutcome: LegacyAuthObservation['outcome'];
  legacyClass: LegacyAuthClass;
}

export interface ProviderAuthCoordinatorOptions {
  now?: () => number;
  cacheTtlMs?: number;
  probes?: Partial<Record<AgentProvider, ProviderAuthProbe>>;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

function envGeneration(env: Record<string, string | undefined>): string {
  const inspection = inspectClaudeCredentialEnv(env);
  return `${inspection.presentNames.join(',')}|${inspection.configDirSet ? '1' : '0'}`;
}

function expectedLegacyOutcome(snapshot: ProviderAuthSnapshot): 'allow' | 'block' {
  if (snapshot.state === 'reauthentication-required' || snapshot.state === 'provider-unavailable') return 'block';
  return 'allow';
}

export function createProviderAuthCoordinator(options: ProviderAuthCoordinatorOptions = {}) {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? AUTH_SHADOW_CACHE_TTL_MS;
  const log = options.log ?? ((message: string) => console.info(message));
  const probes: Record<AgentProvider, ProviderAuthProbe> = {
    claude: options.probes?.claude ?? createClaudeAuthProbe(),
    codex: options.probes?.codex ?? createCodexAuthProbe(),
  };

  const snapshots = new Map<AgentProvider, ProviderAuthSnapshot>();
  const inflight = new Map<string, Promise<ProviderAuthSnapshot>>();
  let generation = 0;
  let lastEnvGeneration = envGeneration(options.env ?? process.env);
  const comparisons: AuthShadowComparison[] = [];

  const currentEnv = () => options.env ?? process.env;

  const refreshGeneration = () => {
    const next = envGeneration(currentEnv());
    if (next !== lastEnvGeneration) {
      lastEnvGeneration = next;
      generation += 1;
      inflight.clear();
      snapshots.clear();
    }
  };

  const cacheKey = (provider: AgentProvider) => `${provider}:${generation}:${lastEnvGeneration}`;

  const cached = (provider: AgentProvider): ProviderAuthSnapshot | undefined => {
    const snapshot = snapshots.get(provider);
    if (!snapshot) return undefined;
    if (now() - snapshot.checkedAt > cacheTtlMs) return undefined;
    return snapshot;
  };

  async function probe(provider: AgentProvider, cliVersion?: string): Promise<ProviderAuthSnapshot> {
    refreshGeneration();
    const hit = cached(provider);
    if (hit) return hit;
    const key = cacheKey(provider);
    const existing = inflight.get(key);
    if (existing) return existing;

    const pending = probes[provider].run({
      env: currentEnv(),
      cliVersion,
      now: now(),
    }).then(snapshot => {
      if (healthContainsSecretLikeValue(snapshot)) {
        const redacted = unprobedAuthSnapshot(provider, now(), cliVersion);
        snapshots.set(provider, redacted);
        return redacted;
      }
      snapshots.set(provider, snapshot);
      return snapshot;
    }).finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
    inflight.set(key, pending);
    return pending;
  }

  function observeLegacy(provider: AgentProvider, legacy: LegacyAuthObservation, snapshot?: ProviderAuthSnapshot) {
    const current = snapshot ?? snapshots.get(provider);
    if (!current) return;
    const agree = expectedLegacyOutcome(current) === legacy.outcome
      || (legacy.class === 'env-bypass' && current.reasonCode === 'named-credential-present')
      || (legacy.class === 'inconclusive-allow' && (current.state === 'degraded' || current.state === 'unknown'));
    const comparison: AuthShadowComparison = {
      provider,
      agree,
      classifierState: current.state,
      classifierReason: current.reasonCode,
      legacyOutcome: legacy.outcome,
      legacyClass: legacy.class,
    };
    comparisons.push(comparison);
    if (comparisons.length > 50) comparisons.shift();
    const line = `[auth-shadow] ${provider} classifier=${current.state} reason=${current.reasonCode} legacy=${legacy.outcome}/${legacy.class} agree=${agree}`;
    if (healthContainsSecretLikeValue(line) || healthContainsSecretLikeValue(comparison)) return;
    log(line);
  }

  return {
    async probe(provider: AgentProvider, cliVersion?: string) {
      return probe(provider, cliVersion);
    },

    record(snapshot: ProviderAuthSnapshot) {
      if (healthContainsSecretLikeValue(snapshot)) return;
      snapshots.set(snapshot.provider, snapshot);
    },

    observeCollected(provider: AgentProvider, input: ClaudeAuthProbeInput, legacy: LegacyAuthObservation) {
      const classified = classifyClaudeAuthOutput(input);
      const snapshot: ProviderAuthSnapshot = {
        provider,
        state: classified.state,
        credentialMode: classified.credentialMode,
        evidence: classified.evidence,
        reasonCode: classified.reasonCode,
        checkedAt: now(),
        ...(input.cliVersion ? { cliVersion: input.cliVersion } : {}),
        ...(classified.recoveryAction ? { recoveryAction: classified.recoveryAction } : {}),
      };
      if (!healthContainsSecretLikeValue(snapshot)) snapshots.set(provider, snapshot);
      observeLegacy(provider, legacy, snapshot);
      return snapshot;
    },

    invalidate(provider?: AgentProvider) {
      generation += 1;
      inflight.clear();
      if (provider) snapshots.delete(provider);
      else snapshots.clear();
    },

    getSnapshot(provider: AgentProvider, cliVersion?: string): ProviderAuthSnapshot {
      return snapshots.get(provider) ?? unprobedAuthSnapshot(provider, now(), cliVersion);
    },

    async snapshotsFor(providers: RuntimeProviderIdentity[]): Promise<ProviderAuthSnapshot[]> {
      return Promise.all(providers.map(provider => probe(provider.provider, provider.cliVersion)));
    },

    observeLegacy,

    comparisons() {
      return [...comparisons];
    },
  };
}

export type ProviderAuthCoordinator = ReturnType<typeof createProviderAuthCoordinator>;

export const providerAuthCoordinator: ProviderAuthCoordinator = (globalThis as any).__providerAuthCoordinator ??= createProviderAuthCoordinator();
(globalThis as any).__providerAuthCoordinator = providerAuthCoordinator;

export function currentAuthCoordinator(): ProviderAuthCoordinator {
  return ((globalThis as any).__providerAuthCoordinator as ProviderAuthCoordinator | undefined) ?? providerAuthCoordinator;
}
