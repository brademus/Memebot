import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function clientId(req: Request): string {
  // Never trust a caller-supplied X-Forwarded-For value directly. Railway's socket
  // peer is stable and non-spoofable; a shared proxy bucket is conservative but safe.
  return req.socket.remoteAddress || req.ip || 'unknown';
}

function sweepExpired(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

export function rateLimit(name: string, max: number, windowMs: number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweepExpired(now);
    const key = `${name}:${clientId(req)}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    next();
  };
}

export function adminKeyMatches(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const suppliedDigest = crypto.createHash('sha256').update(supplied, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}

function suppliedAdminKey(req: Request): string {
  const header = String(req.header?.('x-admin-key') || '').trim();
  if (header) return header;
  const authorization = String(req.header?.('authorization') || '').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1].trim() : '';
}

function isReadOnlyReportRequest(req: Request): boolean {
  const originalPath = String(req.originalUrl || '').split('?')[0];
  const mountedPath = `${String(req.baseUrl || '')}${String(req.path || '')}`;
  const path = originalPath || mountedPath || String(req.path || '');
  if (path === '/api/report' && req.method === 'GET') return true;
  if (path === '/api/system-monitor' && req.method === 'GET') return true;
  if (path === '/api/ai-review' && req.method === 'GET') return true;
  if (path === '/api/status' && req.method === 'GET') return true;
  if (path === '/api/wallet-rankings' && req.method === 'GET') return true;
  if (path === '/api/wallets' && req.method === 'GET') return true;
  if (path === '/api/daily-review-jobs' && req.method === 'POST') return true;
  if (/^\/api\/daily-review-jobs\/[^/]+(?:\/chunks\/\d+)?$/.test(path) && req.method === 'GET') return true;
  return false;
}

// Reports and diagnostics are read-only and intentionally accessible for this private-use
// deployment. Actual mutations remain fail-closed and still require ADMIN_KEY.
export const adminOnly: RequestHandler = (req, res, next) => {
  if (isReadOnlyReportRequest(req)) {
    next();
    return;
  }

  const expected = String(process.env.ADMIN_KEY || '').trim();
  if (!expected) {
    res.status(503).json({ error: 'ADMIN_KEY is not configured on the server' });
    return;
  }
  const supplied = suppliedAdminKey(req);
  if (!adminKeyMatches(supplied, expected)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="memebot-admin"');
    res.status(401).json({ error: 'invalid admin key' });
    return;
  }
  next();
};

export const publicApiLimit = rateLimit('api', 180, 60_000);
export const expensiveApiLimit = rateLimit('expensive', 8, 60_000);
export const streamConnectLimit = rateLimit('stream', 12, 60_000);
