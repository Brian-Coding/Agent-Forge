import { expect, test } from 'bun:test';
import {
  labelListeningPort,
  parsePowerShellProcessJson,
  parsePsPidCommandList,
  parseWmicProcessList,
  portFromUrl,
  projectNameFromCommandLine,
} from './port-labels';

const store = {
  name: 'Acme Store - Web',
  cwd: 'C:\\Users\\dev\\code\\acme-store',
  testUrl: 'http://localhost:5173',
};

test('portFromUrl reads explicit and default HTTP ports', () => {
  expect(portFromUrl('http://localhost:5173')).toBe(5173);
  expect(portFromUrl('http://127.0.0.1/')).toBe(80);
  expect(portFromUrl('not a url :9000/path')).toBe(9000);
  expect(portFromUrl(undefined)).toBeNull();
});

test('WMIC and ps command-line tables keep only useful pid rows', () => {
  const wmic = parseWmicProcessList([
    'CommandLine=C:\\nvm4w\\nodejs\\node.exe C:\\repo\\node_modules\\vite\\bin\\vite.js',
    'ProcessId=4400',
    '',
    'CommandLine=',
    'ProcessId=4',
    '',
    'ProcessId=88',
  ].join('\r\n'));
  expect(wmic.get(4400)).toContain('vite.js');
  expect(wmic.has(4)).toBe(false);
  expect(wmic.has(88)).toBe(false);

  const ps = parsePsPidCommandList('  4400 /usr/local/bin/node ./node_modules/vite/bin/vite.js\n   1 /sbin/init\n');
  expect(ps.get(4400)).toContain('vite.js');

  const json = parsePowerShellProcessJson(JSON.stringify([
    { ProcessId: 4400, CommandLine: 'node vite.js' },
    { ProcessId: 12, CommandLine: null },
  ]));
  expect(json.get(4400)).toBe('node vite.js');
  expect(json.has(12)).toBe(false);
});

test('project names come from the folder above node_modules, not the runtime binary', () => {
  expect(projectNameFromCommandLine(
    'C:\\nvm4w\\nodejs\\node.exe C:\\Users\\dev\\code\\Orbit-Planner\\node_modules\\vite\\bin\\vite.js',
  )).toBe('Orbit Planner');
});

test('labels prefer workspace names and known kinds over raw image names', () => {
  expect(labelListeningPort({
    port: 5173,
    pid: 4400,
    command: 'node',
    commandLine: 'C:\\Users\\dev\\code\\acme-store\\node_modules\\vite\\bin\\vite.js',
    workspaces: [store],
  }).label).toBe('Vite · Acme Store - Web');

  expect(labelListeningPort({
    port: 3333,
    pid: 100,
    command: 'bun',
    commandLine: 'C:\\Users\\dev\\code\\AI-Agent-Forge\\src\\server\\index.ts',
    listenPort: 3333,
    selfPid: 100,
  })).toEqual({ label: 'This Agent Forge', self: true });

  expect(labelListeningPort({
    port: 1420,
    pid: 200,
    command: 'node',
    commandLine: 'C:\\Users\\dev\\code\\Orbit-Planner\\node_modules\\@tauri-apps\\cli\\tauri.js',
  }).label).toBe('Tauri · Orbit Planner');

  expect(labelListeningPort({
    port: 8000,
    pid: 300,
    command: 'UnrealEditor',
    commandLine: '"C:\\Program Files\\Epic Games\\UE_5.6\\Engine\\Binaries\\Win64\\UnrealEditor.exe" C:\\Users\\dev\\code\\games\\Foo.uproject',
  }).label).toBe('Unreal Editor');

  expect(labelListeningPort({
    port: 8090,
    pid: 400,
    command: 'nordvpn-service',
  }).label).toBe('NordVPN');

  expect(labelListeningPort({
    port: 9000,
    pid: 500,
    command: 'node',
  }).label).toBe('Node app');

  expect(labelListeningPort({
    port: 1436,
    pid: 600,
    command: 'zombie-collapse-devhost',
  }).label).toBe('Zombie Collapse Devhost');
});
