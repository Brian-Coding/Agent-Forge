export const ATLAS_ANSWER_START = 'ATLAS_ANSWER_JSON_START';
export const ATLAS_ANSWER_END = 'ATLAS_ANSWER_JSON_END';

const MAX_RAW_LENGTH = 40_000;
const MAX_ANSWER_LENGTH = 20_000;
const MAX_CITATIONS = 40;
const ATLAS_ID_RE = /\b(?:surface|entity|flow)\.[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\b/gi;

export interface AtlasQueryAnswer {
  answer: string;
  citations: string[];
}

export class AtlasAnswerValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('; '));
    this.name = 'AtlasAnswerValidationError';
  }
}

export function parseAtlasQueryAnswer(
  text: string,
  allowedIds: ReadonlySet<string>,
): AtlasQueryAnswer {
  const errors: string[] = [];
  if (!text || text.length > MAX_RAW_LENGTH) {
    throw new AtlasAnswerValidationError([
      !text ? 'Atlas Analyst returned no answer' : 'Atlas Analyst answer exceeded the size limit',
    ]);
  }

  const starts = [...text.matchAll(new RegExp(ATLAS_ANSWER_START, 'g'))];
  const ends = [...text.matchAll(new RegExp(ATLAS_ANSWER_END, 'g'))];
  if (starts.length !== 1 || ends.length !== 1) {
    throw new AtlasAnswerValidationError(['Atlas Analyst must return exactly one structured answer envelope']);
  }
  const start = starts[0]!.index! + ATLAS_ANSWER_START.length;
  const end = ends[0]!.index!;
  if (end <= start) throw new AtlasAnswerValidationError(['Atlas Analyst answer envelope is malformed']);

  let payload: any;
  try {
    payload = JSON.parse(text.slice(start, end).trim());
  } catch {
    throw new AtlasAnswerValidationError(['Atlas Analyst answer envelope contains invalid JSON']);
  }

  const answer = typeof payload?.answer === 'string' ? payload.answer.trim() : '';
  const citations: string[] = Array.isArray(payload?.citations)
    ? payload.citations.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  if (!answer) errors.push('Atlas Analyst answer is empty');
  if (answer.length > MAX_ANSWER_LENGTH) errors.push('Atlas Analyst answer exceeded the narrative limit');
  if (!Array.isArray(payload?.citations)) errors.push('Atlas Analyst citations must be an array');
  if (citations.length === 0) errors.push('Atlas Analyst must cite at least one Atlas ID');
  if (citations.length > MAX_CITATIONS) errors.push(`Atlas Analyst cited more than ${MAX_CITATIONS} Atlas IDs`);
  if (new Set(citations).size !== citations.length) errors.push('Atlas Analyst citations must be unique');

  for (const citation of citations) {
    if (!allowedIds.has(citation)) errors.push(`Unknown Atlas citation: ${citation}`);
    if (answer && !answer.includes(citation)) errors.push(`Atlas citation is not present in the answer: ${citation}`);
  }
  const mentionedIds = [...new Set<string>(answer.match(ATLAS_ID_RE) || [])];
  for (const id of mentionedIds) {
    if (!allowedIds.has(id)) errors.push(`Answer mentions an unknown Atlas ID: ${id}`);
    if (!citations.includes(id)) errors.push(`Answer mentions an uncatalogued citation: ${id}`);
  }

  if (errors.length > 0) throw new AtlasAnswerValidationError([...new Set(errors)]);
  return { answer, citations };
}
