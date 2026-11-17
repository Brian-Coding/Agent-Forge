/** Totals reported during one provider process run; absent fields are unknown. */
export interface ReportedUsage { inputTokens?: number; outputTokens?: number; costUsd?: number }
export function reportedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function reportedSum(...values: unknown[]): number | undefined {
  const known = values.map(reportedNumber).filter((value): value is number => value !== undefined);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : undefined;
}
export function normalizeReportedUsage(value: unknown): ReportedUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return { inputTokens: reportedNumber(record.inputTokens), outputTokens: reportedNumber(record.outputTokens), costUsd: reportedNumber(record.costUsd) };
}
