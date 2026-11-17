import { broadcast } from '../../src/server/broadcast';
import { STATIC_AGENT_DEFINITIONS } from '../../src/server/agents/agent-kinds';
import { modelCatalogService } from '../../src/server/services/model-catalog.service';
import { limitsService } from '../../src/server/services/limits.service';
import { usageService } from '../../src/server/services/usage.service';
import { createRuntimeTruth, runtimeTruth } from '../../src/server/services/runtime-truth';
import { createProviderAuthCoordinator, providerAuthCoordinator } from '../../src/server/auth/provider-auth-coordinator';
import { unprobedAuthSnapshot } from '../../src/shared/runtime-health';
import type { AgentProvider, LimitsSnapshot, ProviderLimitsSnapshot } from '../../src/shared/protocol';

/** Install only in the disposable demo process, before importing the server. */
export function installOfflineDemoServices(): void {
  const unavailable = (provider: AgentProvider): ProviderLimitsSnapshot => ({
    provider, status: 'unavailable', updatedAt: null, checkedAt: Date.now(),
    model: null, planType: null, contextUsedPercent: null,
    fiveHour: { usedPercent: null, resetsAt: null, windowMinutes: null },
    weekly: { usedPercent: null, resetsAt: null, windowMinutes: null },
    modelWeekly: { usedPercent: null, resetsAt: null, windowMinutes: null },
    source: 'Scripted demo', detail: 'Account discovery is disabled in this demo.',
  });
  const snapshot: LimitsSnapshot = { providers: { claude: unavailable('claude'), codex: unavailable('codex') }, refreshIntervalMs: 0, nextRefreshAt: 0 };
  limitsService.start = () => {};
  limitsService.getSnapshot = () => snapshot;
  limitsService.refresh = async (broadcastIt = true) => {
    if (broadcastIt) broadcast({ type: 'limits_snapshot', snapshot });
    return snapshot;
  };
  usageService.startSync = () => {};
  modelCatalogService.get = async () => structuredClone(STATIC_AGENT_DEFINITIONS);
  Object.assign(providerAuthCoordinator, createProviderAuthCoordinator({ probes: {
    claude: { provider: 'claude', run: async () => unprobedAuthSnapshot('claude', Date.now()) },
    codex: { provider: 'codex', run: async () => unprobedAuthSnapshot('codex', Date.now()) },
  } }));
  Object.assign(runtimeTruth, createRuntimeTruth({
    probeProviders: () => (['claude', 'codex'] as const).map(provider => ({ provider, cliName: 'Scripted stand-in', available: false })),
    getAuthSnapshots: () => (['claude', 'codex'] as const).map(provider => unprobedAuthSnapshot(provider, Date.now())),
  }));
}
