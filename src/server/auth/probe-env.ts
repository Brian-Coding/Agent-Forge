export function versionProbeEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE'] as const) {
    const value = source[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  return env;
}
