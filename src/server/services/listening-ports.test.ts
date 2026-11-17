import { expect, test } from 'bun:test';
import { parseSsListeners } from './listening-ports';

test('ss fallback parses IPv4/IPv6 listeners, deduplicates, and omits unsafe or unidentified owners', () => {
  expect(parseSsListeners([
    'LISTEN 0 511 127.0.0.1:5187 0.0.0.0:* users:(("node",pid=1234,fd=18))',
    'LISTEN 0 511 [::1]:5187 [::]:* users:(("node",pid=1234,fd=19))',
    'LISTEN 0 511 *:3000 *:* users:(("bun",pid=4567,fd=20))',
    'LISTEN 0 511 *:40000 *:* users:(("node",pid=9999,fd=20))',
    'LISTEN 0 511 *:22 *:* users:(("system",pid=1,fd=20))',
    'LISTEN 0 511 *:8888 *:*',
    'ESTAB 0 0 127.0.0.1:5187 127.0.0.1:9000 users:(("node",pid=3456,fd=20))',
  ].join('\n'))).toEqual([{ port: 3000, pid: 4567, command: 'bun' }, { port: 5187, pid: 1234, command: 'node' }]);
});
