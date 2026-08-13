import { expect, test } from 'bun:test';
import { buildBrowserWorkerEnv, parseWorkerReadyPort } from './browser.service';

test('browser worker inherits platform/runtime settings without provider secrets', () => {
  const env = buildBrowserWorkerEnv({
    PATH: '/tools',
    HOME: '/home/fixture',
    TEMP: '/tmp',
    LANG: 'en_US.UTF-8',
    XDG_RUNTIME_DIR: '/runtime',
    PLAYWRIGHT_BROWSERS_PATH: '/browsers',
    HTTPS_PROXY: 'http://proxy.invalid',
    ANTHROPIC_API_KEY: 'must-not-cross-boundary',
    CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross-boundary',
    GITHUB_TOKEN: 'must-not-cross-boundary',
    RANDOM_APPLICATION_SECRET: 'must-not-cross-boundary',
  }, '/artifacts');

  expect(env).toMatchObject({
    PATH: '/tools',
    HOME: '/home/fixture',
    TEMP: '/tmp',
    LANG: 'en_US.UTF-8',
    XDG_RUNTIME_DIR: '/runtime',
    PLAYWRIGHT_BROWSERS_PATH: '/browsers',
    HTTPS_PROXY: 'http://proxy.invalid',
    AGENT_FORGE_ARTIFACT_ROOT: '/artifacts',
  });
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.RANDOM_APPLICATION_SECRET).toBeUndefined();
});

test('browser worker readiness accepts only a framed valid TCP port', () => {
  expect(parseWorkerReadyPort('diagnostic\nREADY:43123\n')).toBe(43123);
  expect(parseWorkerReadyPort('READY:0\n')).toBeNull();
  expect(parseWorkerReadyPort('READY:65536\n')).toBeNull();
  expect(parseWorkerReadyPort('noise READY:1234 suffix')).toBeNull();
  expect(parseWorkerReadyPort('READY:not-a-port\n')).toBeNull();
});
