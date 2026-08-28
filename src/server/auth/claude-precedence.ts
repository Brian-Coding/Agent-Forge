import type { ProviderCredentialMode } from '../../shared/runtime-health';

export const CLAUDE_AUTH_COMPATIBILITY_FLOOR = '2.1.241';

export const CLAUDE_CREDENTIAL_ENV_PRECEDENCE = [
  { name: 'ANTHROPIC_AUTH_TOKEN', mode: 'auth-token' as const },
  { name: 'ANTHROPIC_API_KEY', mode: 'api-key' as const },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'setup-token' as const },
] as const;

export interface ClaudeCredentialEnvInspection {
  presentNames: string[];
  highest?: { name: string; mode: ProviderCredentialMode };
  conflict: boolean;
  configDirSet: boolean;
}

export function inspectClaudeCredentialEnv(
  env: Record<string, string | undefined> = {},
): ClaudeCredentialEnvInspection {
  const presentNames = CLAUDE_CREDENTIAL_ENV_PRECEDENCE
    .filter(entry => typeof env[entry.name] === 'string' && env[entry.name]!.length > 0)
    .map(entry => entry.name);
  const highestName = presentNames[0];
  const highest = CLAUDE_CREDENTIAL_ENV_PRECEDENCE.find(entry => entry.name === highestName);
  return {
    presentNames,
    ...(highest ? { highest: { name: highest.name, mode: highest.mode } } : {}),
    conflict: presentNames.length > 1,
    configDirSet: typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.length > 0,
  };
}

export function parseDottedVersion(value: string): [number, number, number] | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isBelowCompatibilityFloor(
  version: string | undefined,
  floor = CLAUDE_AUTH_COMPATIBILITY_FLOOR,
): boolean {
  if (!version) return false;
  const parsed = parseDottedVersion(version);
  const floorParsed = parseDottedVersion(floor);
  if (!parsed || !floorParsed) return false;
  for (let i = 0; i < 3; i++) {
    if (parsed[i]! < floorParsed[i]!) return true;
    if (parsed[i]! > floorParsed[i]!) return false;
  }
  return false;
}
