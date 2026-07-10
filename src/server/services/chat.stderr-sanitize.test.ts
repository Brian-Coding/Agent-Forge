import { test, expect } from 'bun:test';
import { sanitizeStderrForChat } from './chat.service';

test('passes plain diagnostic text through unchanged', () => {
  const line = 'error: failed to connect to model endpoint\n';
  expect(sanitizeStderrForChat(line)).toBe(line);
});

test('strips ANSI color escapes but keeps the message', () => {
  const line = '\x1b[31mERROR\x1b[0m something broke';
  expect(sanitizeStderrForChat(line)).toBe('ERROR something broke');
});

test('drops a binary/mojibake dump entirely (the chat-flood bug)', () => {
  // Simulates a crashing CLI spilling native bytes decoded as U+FFFD, plus
  // x86 prologue text like the AWAVAUATVWUSH seen in the report screenshots.
  const junk = 'H��$�L���AWAVAUATVWUSH���\x01\x02\x03\x00\x1b';
  expect(sanitizeStderrForChat(junk)).toBe('');
});

test('removes stray control bytes from otherwise-readable text', () => {
  expect(sanitizeStderrForChat('ok\x00 line')).toBe('ok line');
});

test('preserves tabs and newlines', () => {
  expect(sanitizeStderrForChat('a\tb\nc')).toBe('a\tb\nc');
});

test('keeps legitimate non-ASCII (emoji/accents)', () => {
  const line = 'résumé ✅ done';
  expect(sanitizeStderrForChat(line)).toBe(line);
});

test('empty in, empty out', () => {
  expect(sanitizeStderrForChat('')).toBe('');
});
