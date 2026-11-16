import { readFile } from 'node:fs/promises';

export async function vendorNotices(): Promise<string> {
  const texts = await Promise.all(['react', 'react-dom', 'scheduler', 'marked', 'dompurify', 'highlight.js'].map(async name => {
    const root = new URL(`../../node_modules/${name}/`, import.meta.url);
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    const license = await readFile(new URL('LICENSE', root), 'utf8').catch(() => readFile(new URL('LICENSE.md', root), 'utf8')).catch(() => readFile(new URL('LICENSE.txt', root), 'utf8'));
    return `${name} ${pkg.version}\n${license}`;
  }));
  return texts.join('\n\n---\n\n');
}
