'use strict';

function backendBase() {
  const raw = String(process.env.MEMEBOT_BACKEND_URL || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

async function handler(req, res) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const id = String(req.query?.id || '').trim();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    res.status(400).json({ error: 'valid BTC report job id is required' });
    return;
  }
  const base = backendBase();
  if (!base) {
    res.status(503).json({ error: 'MEMEBOT_BACKEND_URL is not configured on Vercel' });
    return;
  }
  const target = new URL(`${base.pathname}/api/btc-review-jobs/${encodeURIComponent(id)}`.replace(/\/+/g, '/'), base.origin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json', 'accept-encoding': 'identity', 'x-memebot-proxy': 'vercel-btc-report' },
      signal: controller.signal,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-memebot-upstream', base.host);
    res.end(body);
  } catch (error) {
    res.status(error?.name === 'AbortError' ? 504 : 502).json({
      error: error?.name === 'AbortError' ? 'Railway BTC report status proxy timed out' : 'Railway BTC report status proxy failed',
      detail: String(error?.message || error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = handler;
module.exports.backendBase = backendBase;
