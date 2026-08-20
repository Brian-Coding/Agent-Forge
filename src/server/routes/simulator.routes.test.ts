import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { derivedDataCleanupPaths, handleBootSimulator, parseSimulatorUdid } from './simulator.routes';

test('simulator UDIDs accept UUIDs and booted but reject argv abuse and oversized values', () => {
  expect(parseSimulatorUdid('01234567-89ab-cdef-0123-456789abcdef')).toBe('01234567-89ab-cdef-0123-456789abcdef');
  expect(parseSimulatorUdid('booted')).toBe('booted');
  expect(parseSimulatorUdid('--help')).toBeNull();
  expect(parseSimulatorUdid('x'.repeat(10_000))).toBeNull();
  expect(parseSimulatorUdid(123)).toBeNull();
});

test('simulator mutation rejects malformed, oversized, and invalid bodies before spawning', async () => {
  const malformed = await handleBootSimulator(new Request('http://localhost/api/simulators/boot', { method: 'POST', body: '{' }));
  expect(malformed.status).toBe(400);
  const oversized = await handleBootSimulator(new Request('http://localhost/api/simulators/boot', {
    method: 'POST',
    body: JSON.stringify({ udid: 'x'.repeat(5_000) }),
  }));
  expect(oversized.status).toBe(413);
  const invalid = await handleBootSimulator(new Request('http://localhost/api/simulators/boot', {
    method: 'POST',
    body: JSON.stringify({ udid: '--help' }),
  }));
  expect(invalid.status).toBe(400);
});

test('DerivedData cleanup uses an exact narrow root and a sibling recovery quarantine', () => {
  const fixtureHome = join(process.cwd(), 'fixture-home');
  const paths = derivedDataCleanupPaths(fixtureHome);
  expect(paths).toEqual({
    home: fixtureHome,
    xcodeRoot: join(fixtureHome, 'Library', 'Developer', 'Xcode'),
    derivedDataPath: join(fixtureHome, 'Library', 'Developer', 'Xcode', 'DerivedData'),
    quarantineRoot: join(fixtureHome, 'Library', 'Developer', 'Xcode', '.agent-forge-quarantine'),
  });
});
