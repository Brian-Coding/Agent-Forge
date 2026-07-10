import { usageService } from '../services/usage.service';

/**
 * GET /api/usage/export?format=csv|json
 * Full raw usage-event export for the Tokens tab's export buttons.
 * Localhost-only like every other route (enforced by the server's request guard).
 */
export function handleUsageExport(req: Request): Response {
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const rows = usageService.buildExportRows();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    const header = 'timestamp,iso,agentId,agentName,provider,model,workspaceId,inputTokens,outputTokens,totalTokens,turns,costUsd';
    const escape = (v: string | number) => {
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const body = rows.map(r => [
      r.timestamp, r.iso, r.agentId, r.agentName, r.provider, r.model, r.workspaceId,
      r.inputTokens, r.outputTokens, r.totalTokens, r.turns, r.costUsd,
    ].map(escape).join(',')).join('\n');
    return new Response(header + '\n' + body + '\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="agent-forge-usage-${stamp}.csv"`,
      },
    });
  }

  return new Response(JSON.stringify(rows, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="agent-forge-usage-${stamp}.json"`,
    },
  });
}
