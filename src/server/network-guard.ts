import { randomBytes, timingSafeEqual } from 'node:crypto';

/** A local page is privileged only at this launch's exact origin. */
export function createNetworkGuard() {
  const token = randomBytes(32).toString('base64url');
  const matches = (provided: string | null) => {
    const value = Buffer.from(provided || '');
    const expected = Buffer.from(token);
    return value.length === expected.length && timingSafeEqual(value, expected);
  };
  return {
    token,
    allows(req: Request, expectedOrigin: string): boolean {
      try {
        const url = new URL(req.url);
        if (url.origin !== expectedOrigin) return false;
        const host = req.headers.get('host');
        if (host && host !== new URL(expectedOrigin).host) return false;
        const origin = req.headers.get('origin');
        if (origin !== null && origin !== expectedOrigin) return false;
        const site = req.headers.get('sec-fetch-site');
        if (site && site !== 'same-origin' && site !== 'none') return false;
        if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const protocols = req.headers.get('sec-websocket-protocol')?.split(',').map(p => p.trim()) || [];
          return protocols.some(p => p.startsWith('forge-auth.') && matches(p.slice(11)));
        }
        if (!['GET', 'HEAD'].includes(req.method)) return matches(req.headers.get('x-forge-token'));
        return true;
      } catch { return false; }
    },
  };
}
