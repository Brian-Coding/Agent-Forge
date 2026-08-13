import { expect, test } from 'bun:test';
import { parseServerPort } from './server-config';

test('server port configuration has a stable default and reserves fallback range', () => {
  expect(parseServerPort(undefined)).toBe(3333);
  expect(parseServerPort(' 4000 ')).toBe(4000);
  expect(parseServerPort('65528')).toBe(65528);
});

test('invalid, ambiguous, and fallback-overflowing ports fail startup explicitly', () => {
  for (const value of ['abc', '12x', '0', '-1', '1.5', '65529', '999999999999999999999']) {
    expect(() => parseServerPort(value)).toThrow('PORT must');
  }
});
