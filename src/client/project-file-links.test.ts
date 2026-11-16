import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const start = source.indexOf('    function projectFilePathFromHref');
const end = source.indexOf('    function rewriteProjectFileLinks', start);
const parse = new Function(source.slice(start, end) + ';return projectFilePathFromHref;')();
test('file links decode once after URL parsing, including spaces and Unicode', () => {
  for (const [input, expected] of [
    ['file:///demo/notes%20list.md', '/demo/notes list.md'],
    ['file:///demo/caf%C3%A9.md', '/demo/café.md'],
    ['file:///C:/demo/notes%20list.md', 'C:/demo/notes list.md'],
    ['/demo/notes%20list.md', '/demo/notes list.md'],
    ['file:///demo/percent%2520name.md', '/demo/percent%20name.md'],
    ['https://example.test/file.md', null], ['//example.test/file.md', null],
  ]) expect(parse(input)).toBe(expected);
});
