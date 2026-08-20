import { jsonResponse } from '../utils';
import { getModelCatalog } from '../services/model-catalog.service';

export async function handleGetModels(
  req: Request,
  loadCatalog: typeof getModelCatalog = getModelCatalog,
): Promise<Response> {
  try {
    const url = new URL(req.url);
    const providers = await loadCatalog(url.searchParams.get('refresh') === '1');
    return jsonResponse({ providers });
  } catch (e: any) {
    return jsonResponse({ error: e?.message || 'Failed to load models' }, 500);
  }
}
