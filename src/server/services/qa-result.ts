import type {
  QaAssertionInfo,
  QaEvidenceInfo,
  QaFindingInfo,
  QaVerdict,
} from '../../shared/protocol';

export const QA_RESULT_START = 'QA_RESULT_JSON_START';
export const QA_RESULT_END = 'QA_RESULT_JSON_END';

export interface QaResultEnvelope {
  schemaVersion: 1;
  runId: string;
  verdict: QaVerdict;
  summary: string;
  assertions: QaAssertionInfo[];
  evidence: QaEvidenceInfo[];
  findings: QaFindingInfo[];
  atlasSurfaceIds?: string[];
}

export interface ParsedQaResult {
  authoritative: boolean;
  verdict: QaVerdict;
  summary: string;
  reportBody: string;
  validationErrors: string[];
  envelope?: QaResultEnvelope;
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
const ATLAS_SURFACE_RE = /^surface\.[a-z0-9][a-z0-9-]*$/;
const VERDICTS = new Set<QaVerdict>(['pass', 'warnings', 'fail', 'inconclusive']);
const ASSERTION_STATUSES = new Set(['passed', 'failed', 'warning', 'not_run']);
const EVIDENCE_KINDS = new Set(['screenshot', 'console', 'network', 'observation']);
const FINDING_SEVERITIES = new Set(['critical', 'major', 'minor', 'note']);
const MAX_ENVELOPE_CHARS = 250_000;
const MAX_REPORT_BODY_CHARS = 50_000;

function isNonEmptyString(value: unknown, max = 20_000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 100
    && value.every(item => typeof item === 'string' && item.length <= 1000);
}

function stripMachineEnvelope(raw: string): { body: string; json: string | null } {
  const start = raw.indexOf(QA_RESULT_START);
  const end = start >= 0 ? raw.indexOf(QA_RESULT_END, start + QA_RESULT_START.length) : -1;
  if (start < 0 || end < 0) return { body: raw.trim(), json: null };
  const json = raw.slice(start + QA_RESULT_START.length, end).trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const body = `${raw.slice(0, start)}\n${raw.slice(end + QA_RESULT_END.length)}`
    .replace(/```json\s*$/i, '')
    .replace(/^```\s*/i, '')
    .trim();
  return { body, json };
}

function validateEnvelope(value: unknown, expectedRunId: string): { envelope?: QaResultEnvelope; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') return { errors: ['Structured QA result must be a JSON object'] };
  const obj = value as Record<string, unknown>;
  try {
    if (JSON.stringify(obj).length > MAX_ENVELOPE_CHARS) errors.push(`Structured QA result exceeds ${MAX_ENVELOPE_CHARS} characters`);
  } catch {
    errors.push('Structured QA result could not be serialized');
  }
  if (obj.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (obj.runId !== expectedRunId) errors.push('runId does not match the executing QA run');
  if (!VERDICTS.has(obj.verdict as QaVerdict)) errors.push('verdict must be pass, warnings, fail, or inconclusive');
  if (!isNonEmptyString(obj.summary, 1000)) errors.push('summary must be a non-empty string of at most 1000 characters');
  if (!Array.isArray(obj.assertions) || obj.assertions.length > 100) errors.push('assertions must be an array with at most 100 entries');
  if (!Array.isArray(obj.evidence) || obj.evidence.length > 200) errors.push('evidence must be an array with at most 200 entries');
  if (!Array.isArray(obj.findings) || obj.findings.length > 100) errors.push('findings must be an array with at most 100 entries');

  const assertions = Array.isArray(obj.assertions) ? obj.assertions : [];
  const evidence = Array.isArray(obj.evidence) ? obj.evidence : [];
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  const evidenceIds = new Set<string>();
  const assertionIds = new Set<string>();
  const findingIds = new Set<string>();

  for (const raw of evidence) {
    if (!raw || typeof raw !== 'object') { errors.push('Every evidence entry must be an object'); continue; }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) errors.push(`Invalid evidence ID: ${String(item.id)}`);
    else if (evidenceIds.has(item.id)) errors.push(`Duplicate evidence ID: ${item.id}`);
    else evidenceIds.add(item.id);
    if (!EVIDENCE_KINDS.has(item.kind as string)) errors.push(`Evidence ${String(item.id)} has invalid kind`);
    if (!isNonEmptyString(item.label, 1000)) errors.push(`Evidence ${String(item.id)} has no label`);
    if (item.ref !== undefined && (typeof item.ref !== 'string' || item.ref.length > 4000)) errors.push(`Evidence ${String(item.id)} ref must be a string of at most 4000 characters`);
    if (item.detail !== undefined && (typeof item.detail !== 'string' || item.detail.length > 20_000)) errors.push(`Evidence ${String(item.id)} detail must be a string of at most 20000 characters`);
    if (item.kind === 'screenshot' && !isNonEmptyString(item.ref, 4000)) errors.push(`Screenshot evidence ${String(item.id)} needs a path in ref`);
    if (item.kind !== 'screenshot' && !isNonEmptyString(item.detail, 20_000)) errors.push(`Evidence ${String(item.id)} needs captured facts in detail`);
  }

  for (const raw of assertions) {
    if (!raw || typeof raw !== 'object') { errors.push('Every assertion must be an object'); continue; }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) errors.push(`Invalid assertion ID: ${String(item.id)}`);
    else if (assertionIds.has(item.id)) errors.push(`Duplicate assertion ID: ${item.id}`);
    else assertionIds.add(item.id);
    if (!isNonEmptyString(item.name, 1000)) errors.push(`Assertion ${String(item.id)} has no name`);
    if (!ASSERTION_STATUSES.has(item.status as string)) errors.push(`Assertion ${String(item.id)} has invalid status`);
    if (item.expected !== undefined && !isNonEmptyString(item.expected, 5000)) errors.push(`Assertion ${String(item.id)} expected must be a non-empty string of at most 5000 characters`);
    if (item.observed !== undefined && !isNonEmptyString(item.observed, 5000)) errors.push(`Assertion ${String(item.id)} observed must be a non-empty string of at most 5000 characters`);
    if (!stringArray(item.evidenceIds)) errors.push(`Assertion ${String(item.id)} evidenceIds must be an array`);
    else {
      if (item.status !== 'not_run' && item.evidenceIds.length === 0) errors.push(`Assertion ${String(item.id)} requires evidence`);
      for (const id of item.evidenceIds) if (!evidenceIds.has(id)) errors.push(`Assertion ${String(item.id)} references unknown evidence ${id}`);
    }
    if (item.atlasSurfaceIds !== undefined && (!stringArray(item.atlasSurfaceIds) || item.atlasSurfaceIds.some(id => !ATLAS_SURFACE_RE.test(id)))) {
      errors.push(`Assertion ${String(item.id)} has invalid atlasSurfaceIds`);
    }
  }

  for (const raw of findings) {
    if (!raw || typeof raw !== 'object') { errors.push('Every finding must be an object'); continue; }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) errors.push(`Invalid finding ID: ${String(item.id)}`);
    else if (findingIds.has(item.id)) errors.push(`Duplicate finding ID: ${item.id}`);
    else findingIds.add(item.id);
    if (!FINDING_SEVERITIES.has(item.severity as string)) errors.push(`Finding ${String(item.id)} has invalid severity`);
    if (!isNonEmptyString(item.title, 1000)) errors.push(`Finding ${String(item.id)} has no title`);
    if (!isNonEmptyString(item.details)) errors.push(`Finding ${String(item.id)} has no details`);
    if (!stringArray(item.evidenceIds)) errors.push(`Finding ${String(item.id)} evidenceIds must be an array`);
    else {
      if (item.evidenceIds.length === 0) errors.push(`Finding ${String(item.id)} requires evidence`);
      for (const id of item.evidenceIds) if (!evidenceIds.has(id)) errors.push(`Finding ${String(item.id)} references unknown evidence ${id}`);
    }
    if (item.atlasSurfaceIds !== undefined && (!stringArray(item.atlasSurfaceIds) || item.atlasSurfaceIds.some(id => !ATLAS_SURFACE_RE.test(id)))) {
      errors.push(`Finding ${String(item.id)} has invalid atlasSurfaceIds`);
    }
  }

  if (obj.atlasSurfaceIds !== undefined && (!stringArray(obj.atlasSurfaceIds) || obj.atlasSurfaceIds.some(id => !ATLAS_SURFACE_RE.test(id)))) {
    errors.push('atlasSurfaceIds contains an invalid surface ID');
  }

  const verdict = obj.verdict as QaVerdict;
  if (verdict === 'pass') {
    if (assertions.length === 0) errors.push('PASS requires at least one assertion');
    if (assertions.some(item => (item as any)?.status !== 'passed')) errors.push('PASS requires every assertion to be passed');
    if (!evidence.some(item => (item as any)?.kind === 'screenshot')) errors.push('PASS requires screenshot evidence');
    if (!evidence.some(item => (item as any)?.kind === 'console')) errors.push('PASS requires console evidence');
    if (findings.some(item => ['critical', 'major', 'minor'].includes((item as any)?.severity))) errors.push('PASS cannot include critical, major, or minor findings');
  } else if (verdict === 'warnings') {
    const hasWarning = assertions.some(item => (item as any)?.status === 'warning') || findings.length > 0;
    if (!hasWarning) errors.push('WARNINGS requires a warning assertion or finding');
    if (evidence.length === 0) errors.push('WARNINGS requires evidence');
    if (assertions.some(item => (item as any)?.status === 'failed')) errors.push('WARNINGS cannot include a failed assertion');
    if (findings.some(item => ['critical', 'major'].includes((item as any)?.severity))) errors.push('WARNINGS cannot include critical or major findings');
    if (assertions.some(item => (item as any)?.status === 'not_run')) errors.push('WARNINGS with an unexecuted assertion must be INCONCLUSIVE');
  } else if (verdict === 'fail') {
    const hasFailure = assertions.some(item => (item as any)?.status === 'failed')
      || findings.some(item => ['critical', 'major'].includes((item as any)?.severity));
    if (!hasFailure) errors.push('FAIL requires a failed assertion or critical/major finding');
    if (evidence.length === 0) errors.push('FAIL requires evidence');
  }

  if (errors.length > 0) return { errors: [...new Set(errors)] };
  return { envelope: obj as unknown as QaResultEnvelope, errors: [] };
}

export function parseQaResult(rawText: string, expectedRunId: string): ParsedQaResult {
  const raw = rawText?.trim() || '';
  const startCount = raw.split(QA_RESULT_START).length - 1;
  const endCount = raw.split(QA_RESULT_END).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    return {
      authoritative: false,
      verdict: 'inconclusive',
      summary: raw ? 'QA agent emitted an ambiguous structured result.' : 'QA agent produced no output.',
      reportBody: raw || '(No QA report was produced.)',
      validationErrors: [`Expected exactly one structured result envelope; found ${startCount} start marker(s) and ${endCount} end marker(s)`],
    };
  }
  const extracted = stripMachineEnvelope(raw);
  if (!extracted.json) {
    return {
      authoritative: false,
      verdict: 'inconclusive',
      summary: raw ? 'QA agent did not emit a structured result.' : 'QA agent produced no output.',
      reportBody: extracted.body || '(No QA report was produced.)',
      validationErrors: ['Missing QA_RESULT_JSON_START / QA_RESULT_JSON_END envelope'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.json);
  } catch (error) {
    return {
      authoritative: false,
      verdict: 'inconclusive',
      summary: 'QA result JSON could not be parsed.',
      reportBody: extracted.body || '(The QA agent emitted only malformed structured output.)',
      validationErrors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const validated = validateEnvelope(parsed, expectedRunId);
  if (!validated.envelope) {
    return {
      authoritative: false,
      verdict: 'inconclusive',
      summary: 'QA result did not meet the evidence contract.',
      reportBody: extracted.body || '(No human-readable QA report was produced.)',
      validationErrors: validated.errors,
    };
  }

  return {
    authoritative: true,
    verdict: validated.envelope.verdict,
    summary: validated.envelope.summary.trim(),
    reportBody: extracted.body || '(Structured QA result completed without a separate narrative.)',
    validationErrors: [],
    envelope: validated.envelope,
  };
}

function stripExistingVerdict(body: string): string {
  return body.replace(/^[ \t]*#{0,3}[ \t]*\*{0,2}[ \t]*(?:✅\s*|⚠️\s*|❌\s*|⚪\s*)?(?:PASS|WARNINGS?|FAIL|INCONCLUSIVE)\b[^\n]*(?:\n+|$)/i, '').trim();
}

export function formatQaReport(result: Pick<ParsedQaResult, 'verdict' | 'summary' | 'reportBody'>): string {
  const labels: Record<QaVerdict, { emoji: string; label: string }> = {
    pass: { emoji: '✅', label: 'PASS' },
    warnings: { emoji: '⚠️', label: 'WARNINGS' },
    fail: { emoji: '❌', label: 'FAIL' },
    inconclusive: { emoji: '⚪', label: 'INCONCLUSIVE' },
  };
  const meta = labels[result.verdict];
  const rawBody = stripExistingVerdict(result.reportBody);
  const body = rawBody.length > MAX_REPORT_BODY_CHARS
    ? `${rawBody.slice(0, MAX_REPORT_BODY_CHARS)}\n\n[QA narrative truncated by Agent Forge]`
    : rawBody;
  return `${meta.emoji} ${meta.label} — ${result.summary}${body ? `\n\n${body}` : ''}`;
}
