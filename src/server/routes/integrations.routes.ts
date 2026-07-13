import { vercelIntegrationService } from '../services/vercel-integration.service';
import { jsonResponse } from '../utils';

export async function handleVercelIntegration(req: Request): Promise<Response> {
  try {
    const status = req.method === 'POST'
      ? await vercelIntegrationService.configure()
      : await vercelIntegrationService.getStatus();
    return jsonResponse(status);
  } catch (error: any) {
    return jsonResponse({ error: error?.message || 'Vercel integration check failed' }, 500);
  }
}
