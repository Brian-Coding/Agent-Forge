import { readFile } from 'node:fs/promises';

export interface CoverageTotals {
  files: number;
  functionsFound: number;
  functionsHit: number;
  linesFound: number;
  linesHit: number;
  functionPercent: number;
  linePercent: number;
  sourceFiles: Set<string>;
}

export interface CoverageRequirements {
  minimumFiles: number;
  minimumFunctionPercent: number;
  minimumLinePercent: number;
  requiredFiles: readonly string[];
}

export const DEFAULT_COVERAGE_REQUIREMENTS: CoverageRequirements = {
  minimumFiles: 65,
  minimumFunctionPercent: 76,
  minimumLinePercent: 70,
  requiredFiles: [
    'src/server/agents/adapters/claude.ts',
    'src/server/agents/adapters/codex.ts',
    'src/server/client-message.ts',
    'src/server/request-body.ts',
    'src/server/services/agent.service.ts',
    'src/server/services/atlas.service.ts',
    'src/server/services/atomic-file.ts',
    'src/server/services/browser.service.ts',
    'src/server/services/chat.service.ts',
    'src/server/services/persistence.service.ts',
    'src/server/services/qa.service.ts',
    'src/server/services/shutdown-coordinator.ts',
    'src/server/services/workspace.service.ts',
    'src/server/ws.ts',
  ],
};

function normalizedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function percentage(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

export function parseLcovCoverage(text: string): CoverageTotals {
  const sourceFiles = new Set<string>();
  let functionsFound = 0;
  let functionsHit = 0;
  let linesFound = 0;
  let linesHit = 0;
  let currentSource: string | null = null;
  let current: Record<'FNF' | 'FNH' | 'LF' | 'LH', number | null> = {
    FNF: null,
    FNH: null,
    LF: null,
    LH: null,
  };

  const finishRecord = () => {
    if (!currentSource) return;
    for (const field of ['FNF', 'FNH', 'LF', 'LH'] as const) {
      if (current[field] === null) throw new Error(`LCOV record ${currentSource} is missing ${field}`);
    }
    if (current.FNH! > current.FNF! || current.LH! > current.LF!) {
      throw new Error(`LCOV record ${currentSource} reports more hits than executable items`);
    }
    if (sourceFiles.has(currentSource)) throw new Error(`LCOV contains duplicate source record: ${currentSource}`);
    sourceFiles.add(currentSource);
    functionsFound += current.FNF!;
    functionsHit += current.FNH!;
    linesFound += current.LF!;
    linesHit += current.LH!;
    currentSource = null;
    current = { FNF: null, FNH: null, LF: null, LH: null };
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.startsWith('SF:')) {
      if (currentSource) throw new Error(`LCOV record ${currentSource} was not terminated`);
      currentSource = normalizedPath(rawLine.slice(3));
      if (!currentSource) throw new Error('LCOV contains an empty source path');
      continue;
    }
    if (rawLine === 'end_of_record') {
      finishRecord();
      continue;
    }
    if (!currentSource) continue;
    const match = rawLine.match(/^(FNF|FNH|LF|LH):(\d+)$/);
    if (match) current[match[1] as keyof typeof current] = Number(match[2]);
  }
  if (currentSource) throw new Error(`LCOV record ${currentSource} was not terminated`);
  if (sourceFiles.size === 0) throw new Error('LCOV report contains no source records');

  return {
    files: sourceFiles.size,
    functionsFound,
    functionsHit,
    linesFound,
    linesHit,
    functionPercent: percentage(functionsHit, functionsFound),
    linePercent: percentage(linesHit, linesFound),
    sourceFiles,
  };
}

export function enforceCoverage(
  totals: CoverageTotals,
  requirements: CoverageRequirements = DEFAULT_COVERAGE_REQUIREMENTS,
): void {
  const failures: string[] = [];
  if (totals.files < requirements.minimumFiles) {
    failures.push(`production source records ${totals.files} < ${requirements.minimumFiles}`);
  }
  if (totals.functionPercent < requirements.minimumFunctionPercent) {
    failures.push(`weighted function coverage ${totals.functionPercent.toFixed(2)}% < ${requirements.minimumFunctionPercent.toFixed(2)}%`);
  }
  if (totals.linePercent < requirements.minimumLinePercent) {
    failures.push(`weighted line coverage ${totals.linePercent.toFixed(2)}% < ${requirements.minimumLinePercent.toFixed(2)}%`);
  }
  const missing = requirements.requiredFiles
    .map(normalizedPath)
    .filter(file => !totals.sourceFiles.has(file));
  if (missing.length > 0) failures.push(`required production records missing: ${missing.join(', ')}`);
  if (failures.length > 0) throw new Error(`Coverage reliability gate failed:\n- ${failures.join('\n- ')}`);
}

export async function checkCoverageFile(
  path = 'coverage/lcov.info',
  requirements: CoverageRequirements = DEFAULT_COVERAGE_REQUIREMENTS,
): Promise<CoverageTotals> {
  const totals = parseLcovCoverage(await readFile(path, 'utf8'));
  enforceCoverage(totals, requirements);
  return totals;
}
