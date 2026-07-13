import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../config';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function clientId(req: Request): string {
  const forwarded = req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || req.ip || req.socket.remoteAddress || 'unknown';
}

function sweepExpired(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
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

function secureEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (!env.ADMIN_KEY) {
    res.status(503).json({ error: 'ADMIN_KEY is not configured' });
    return;
  }
  const bearer = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = req.header('x-admin-key') || bearer || '';
  if (!secureEqual(supplied, env.ADMIN_KEY)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export const publicApiLimit = rateLimit('api', 180, 60_000);
export const expensiveApiLimit = rateLimit('expensive', 8, 60_000);
export const streamConnectLimit = rateLimit('stream', 12, 60_000);
