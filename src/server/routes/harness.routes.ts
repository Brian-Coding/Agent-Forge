import { getBuiltInHarnessInstructionManifest } from '../services/prompt-builder.service';
import { jsonResponse } from '../utils';

/** GET /api/harness/instructions — exact read-only instructions assembled by the server. */
export function handleHarnessInstructions(): Response {
  return jsonResponse(getBuiltInHarnessInstructionManifest());
}
