import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from './atomic-file';

const temporaryDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-atomic-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })));
});

test('atomic writes replace files whose paths contain spaces', async () => {
  const directory = await fixtureDirectory();
  const target = join(directory, 'state with spaces.json');
  await writeFile(target, '{"old":true}');

  await atomicWriteFile(target, '{"new":true}');

  expect(await readFile(target, 'utf8')).toBe('{"new":true}');
  expect(await readdir(directory)).toEqual(['state with spaces.json']);
});

test('a pre-rename failure preserves the old durable file and cleans its temporary file', async () => {
  const directory = await fixtureDirectory();
  const target = join(directory, 'data.json');
  await writeFile(target, '{"generation":1}');

  await expect(atomicWriteFile(target, '{"generation":2}', {
    onPhase(phase) {
      if (phase === 'after-write') throw new Error('injected write interruption');
    },
  })).rejects.toThrow('injected write interruption');

  expect(await readFile(target, 'utf8')).toBe('{"generation":1}');
  expect(await readdir(directory)).toEqual(['data.json']);
});

test('simultaneous writers never expose a mixed or partial payload', async () => {
  const directory = await fixtureDirectory();
  const target = join(directory, 'concurrent.json');
  const payloads = Array.from({ length: 8 }, (_, generation) => ({
    generation,
    marker: String(generation).repeat(2_048),
  }));

  await Promise.all(payloads.map(payload => atomicWriteFile(target, JSON.stringify(payload))));

  const parsed = JSON.parse(await readFile(target, 'utf8'));
  expect(payloads).toContainEqual(parsed);
  expect(parsed.marker).toBe(String(parsed.generation).repeat(2_048));
  expect(await readdir(directory)).toEqual(['concurrent.json']);
});
