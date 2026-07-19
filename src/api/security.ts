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

// Retained as a compatibility export for older tests/tools. No current app route
// uses this comparison while admin authentication is intentionally disabled.
export function adminKeyMatches(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const suppliedDigest = crypto.createHash('sha256').update(supplied, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}

// Authentication is intentionally disabled for the current private-use app. The
// middleware name remains so route wiring stays stable, but every request passes.
// Expensive and mutating routes remain covered by the existing API rate limits.
export const adminOnly: RequestHandler = (_req, _res, next) => next();

export const publicApiLimit = rateLimit('api', 180, 60_000);
export const expensiveApiLimit = rateLimit('expensive', 8, 60_000);
export const streamConnectLimit = rateLimit('stream', 12, 60_000);
