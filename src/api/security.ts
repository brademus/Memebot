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

// MUTATING routes (wallet add/remove) require ADMIN_KEY again. This was removed as
// "intentionally open" — but the smart-wallet list drives what the bot recommends,
// so an open POST /api/wallets on a public URL is a signal-poisoning vector: anyone
// with the URL could inject wallets the bot then follows, or wipe the tracked set.
// The dashboard doesn't call these endpoints, so requiring the key costs nothing.
// Reads stay open; only writes are gated. If ADMIN_KEY is unset, writes are refused.
import { env } from '../config';
export const adminOnly: RequestHandler = (req, res, next) => {
  if (!env.ADMIN_KEY) { res.status(503).json({ error: 'ADMIN_KEY not configured — mutating endpoints disabled' }); return; }
  const supplied = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || (req.query.key as string) || '';
  if (supplied !== env.ADMIN_KEY) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
};

export const publicApiLimit = rateLimit('api', 180, 60_000);
export const expensiveApiLimit = rateLimit('expensive', 8, 60_000);
export const streamConnectLimit = rateLimit('stream', 12, 60_000);
