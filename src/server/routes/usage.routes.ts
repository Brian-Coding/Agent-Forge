import { usageService } from '../services/usage.service';

/**
 * GET /api/usage/export?format=csv|json&scope=current|all
 * Raw usage-event export matching the Tokens tab's selected machine scope.
 * Localhost-only like every other route (enforced by the server's request guard).
 */
export function handleUsageExport(req: Request): Response {
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const scope = url.searchParams.get('scope') === 'current' ? 'current' : 'all';
  const rows = usageService.buildExportRows(scope);
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    const header = 'id,machineId,timestamp,iso,agentId,agentName,provider,model,workspaceId,workspaceName,inputTokens,outputTokens,totalTokens,turns,costUsd';
    const escape = (v: string | number) => {
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const body = rows.map(r => [
      r.id, r.machineId, r.timestamp, r.iso, r.agentId, r.agentName, r.provider, r.model,
      r.workspaceId, r.workspaceName,
      r.inputTokens, r.outputTokens, r.totalTokens, r.turns, r.costUsd,
    ].map(escape).join(',')).join('\n');
    return new Response(header + '\n' + body + '\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="agent-forge-usage-${scope}-${stamp}.csv"`,
      },
    });
  }

  return new Response(JSON.stringify(rows, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="agent-forge-usage-${scope}-${stamp}.json"`,
    },
  });
}
