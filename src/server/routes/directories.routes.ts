import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { jsonResponse } from '../utils';

function getShortcuts(): { name: string; path: string }[] {
  const home = homedir();
  const shortcuts: { name: string; path: string }[] = [];

  const oneDriveDocuments = join(home, 'OneDrive', 'Documents');
  const regularDocuments = join(home, 'Documents');
  if (existsSync(oneDriveDocuments)) {
    shortcuts.push({ name: 'Documents', path: oneDriveDocuments });
  } else if (existsSync(regularDocuments)) {
    shortcuts.push({ name: 'Documents', path: regularDocuments });
  }

  const oneDriveDesktop = join(home, 'OneDrive', 'Desktop');
  const regularDesktop = join(home, 'Desktop');
  if (existsSync(oneDriveDesktop)) {
    shortcuts.push({ name: 'Desktop', path: oneDriveDesktop });
  } else if (existsSync(regularDesktop)) {
    shortcuts.push({ name: 'Desktop', path: regularDesktop });
  }

  const seen = new Set(shortcuts.map(s => s.path.toLowerCase()));
  const projectCandidates = [
    { name: 'projects', path: join(home, 'projects') },
    { name: 'Projects', path: join(home, 'Projects') },
    { name: 'Developer', path: join(home, 'Developer') },
    { name: 'dev', path: join(home, 'dev') },
  ];
  for (const c of projectCandidates) {
    if (existsSync(c.path) && !seen.has(c.path.toLowerCase())) {
      shortcuts.push(c);
      seen.add(c.path.toLowerCase());
    }
  }

  return shortcuts;
}

function getDocumentsPath(): string {
  const home = homedir();
  const oneDriveDocuments = join(home, 'OneDrive', 'Documents');
  if (existsSync(oneDriveDocuments)) return oneDriveDocuments;
  const regularDocuments = join(home, 'Documents');
  if (existsSync(regularDocuments)) return regularDocuments;
  return home;
}

async function listDirectories(path: string): Promise<{ name: string; path: string; isDirectory: boolean }[]> {
  try {
    const entries = readdirSync(path);
    const results = [];
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      try {
        const fullPath = join(path, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push({ name: entry, path: fullPath, isDirectory: true });
        }
      } catch {
        // Skip entries we can't access
      }
    }
    return results.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  } catch (e) {
    return [];
  }
}

export async function handleDirectories(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') || homedir();
  const dirs = await listDirectories(path);
  return jsonResponse({
    path,
    directories: dirs,
    home: homedir(),
    shortcuts: getShortcuts(),
    documentsPath: getDocumentsPath(),
  });
}
