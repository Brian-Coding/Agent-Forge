import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Stable local storage for generated artifacts. Heavy images stay out of
 * data.json and out of project repositories while remaining available after a
 * server restart. */
export function getArtifactRoot(): string {
  const override = process.env.AGENT_FORGE_ARTIFACT_ROOT?.trim();
  if (override) return resolve(override);

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return resolve(join(process.env.LOCALAPPDATA, 'AgentForge', 'artifacts'));
  }

  const xdgData = process.env.XDG_DATA_HOME?.trim();
  if (xdgData) return resolve(join(xdgData, 'agent-forge', 'artifacts'));
  return resolve(join(homedir(), '.local', 'share', 'agent-forge', 'artifacts'));
}

export function safeArtifactSegment(value: string, fallback: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  return safe || fallback;
}
