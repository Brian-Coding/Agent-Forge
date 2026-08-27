import { jsonResponse } from '../utils';
import { getRuntimeHealth } from '../services/runtime-truth';

/** GET /api/health — redacted runtime provenance. Does not probe provider login. */
export async function handleRuntimeHealth(): Promise<Response> {
  return jsonResponse(await getRuntimeHealth());
}
