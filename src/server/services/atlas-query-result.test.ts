import { expect, test } from 'bun:test';
import {
  ATLAS_ANSWER_END,
  ATLAS_ANSWER_START,
  AtlasAnswerValidationError,
  parseAtlasQueryAnswer,
} from './atlas-query-result';

const allowed = new Set(['surface.timeline', 'entity.event', 'flow.open-event']);

function envelope(payload: unknown): string {
  return `${ATLAS_ANSWER_START}\n${JSON.stringify(payload)}\n${ATLAS_ANSWER_END}`;
}

test('Ask Atlas accepts an answer grounded in real graph IDs', () => {
  expect(parseAtlasQueryAnswer(envelope({
    answer: 'The `surface.timeline` renders `entity.event` records through `flow.open-event`.',
    citations: ['surface.timeline', 'entity.event', 'flow.open-event'],
  }), allowed)).toEqual({
    answer: 'The `surface.timeline` renders `entity.event` records through `flow.open-event`.',
    citations: ['surface.timeline', 'entity.event', 'flow.open-event'],
  });
});

test('Ask Atlas rejects invented or uncatalogued IDs', () => {
  expect(() => parseAtlasQueryAnswer(envelope({
    answer: 'Use `surface.invented`.',
    citations: ['surface.invented'],
  }), allowed)).toThrow(AtlasAnswerValidationError);
  expect(() => parseAtlasQueryAnswer(envelope({
    answer: 'Use `surface.timeline` and `entity.event`.',
    citations: ['surface.timeline'],
  }), allowed)).toThrow(/uncatalogued citation/);
});

test('Ask Atlas rejects prose-only and ambiguous envelopes', () => {
  expect(() => parseAtlasQueryAnswer('The timeline is on surface.timeline.', allowed)).toThrow(/structured answer envelope/);
  const duplicate = `${envelope({ answer: 'See surface.timeline.', citations: ['surface.timeline'] })}\n${envelope({ answer: 'See entity.event.', citations: ['entity.event'] })}`;
  expect(() => parseAtlasQueryAnswer(duplicate, allowed)).toThrow(/exactly one/);
});
