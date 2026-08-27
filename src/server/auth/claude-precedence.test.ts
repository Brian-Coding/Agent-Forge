import { expect, test } from 'bun:test';
import {
  inspectClaudeCredentialEnv,
  isBelowCompatibilityFloor,
} from './claude-precedence';

test('credential env inspection reports names only and highest-precedence mode', () => {
  const inspection = inspectClaudeCredentialEnv({
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-secret-seed-xyz',
    ANTHROPIC_API_KEY: 'also-secret',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\dev\\.claude-alt',
  });
  expect(inspection.presentNames).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  expect(inspection.highest).toEqual({ name: 'ANTHROPIC_AUTH_TOKEN', mode: 'auth-token' });
  expect(inspection.conflict).toBe(true);
  expect(inspection.configDirSet).toBe(true);
  expect(JSON.stringify(inspection)).not.toContain('sk-ant-secret-seed-xyz');
  expect(JSON.stringify(inspection)).not.toContain('also-secret');
});

test('empty env is not a conflict and does not invent a credential mode', () => {
  expect(inspectClaudeCredentialEnv({})).toEqual({
    presentNames: [],
    conflict: false,
    configDirSet: false,
  });
});

test('compatibility floor is 2.1.241', () => {
  expect(isBelowCompatibilityFloor('2.1.240')).toBe(true);
  expect(isBelowCompatibilityFloor('2.1.241')).toBe(false);
  expect(isBelowCompatibilityFloor('2.2.0')).toBe(false);
  expect(isBelowCompatibilityFloor(undefined)).toBe(false);
});
