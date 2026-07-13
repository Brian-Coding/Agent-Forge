import { expect, test } from 'bun:test';
import { codexReasoningConfigArg } from './codex';

test('Codex reasoning choices become real CLI configuration overrides', () => {
  expect(codexReasoningConfigArg()).toBe('model_reasoning_effort="medium"');
  expect(codexReasoningConfigArg('extra_high')).toBe('model_reasoning_effort="xhigh"');
  expect(codexReasoningConfigArg('max')).toBe('model_reasoning_effort="max"');
  expect(codexReasoningConfigArg('ultra')).toBe('model_reasoning_effort="ultra"');
});
