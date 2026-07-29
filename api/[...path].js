'use strict';

const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function backendBase() {
  const raw = String(process.env.MEMEBOT_BACKEND_URL || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

function encodeSegments(segments) {
  return segments
    .map(segment => String(segment))
    .filter(Boolean)
    .map(segment => {
      try { return encodeURIComponent(decodeURIComponent(segment)); }
      catch { return encodeURIComponent(segment); }
    })
    .join('/');
}

function requestPath(req) {
  const value = req.query?.path;
  const querySegments = Array.isArray(value) ? value : value == null ? [] : [value];
  const fromQuery = encodeSegments(querySegments);
  if (fromQuery) return fromQuery;

  try {
    const pathname = new URL(String(req.url || '/'), 'https://memebot.local').pathname;
    if (pathname === '/api' || pathname === '/api/') return '';
    const marker = '/api/';
    const index = pathname.indexOf(marker);
    if (index === -1) return '';
    return encodeSegments(pathname.slice(index + marker.length).split('/'));
  } catch {
    return '';
  }
}

function upstreamHeaders(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower.startsWith('x-vercel-')) continue;
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else if (value != null) headers.set(name, String(value));
  }
  headers.set('accept-encoding', 'identity');
  headers.set('x-memebot-proxy', 'vercel');
  return headers;
}

function upstreamBody(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;
  if (req.body == null) return undefined;
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body);
}

async function handler(req, res) {
  const base = backendBase();
  if (!base) {
    res.status(503).json({
      error: 'MEMEBOT_BACKEND_URL is not configured on Vercel',
      action: 'Set it to the public HTTPS domain for the Railway Memebot service, then redeploy Vercel.',
    });
    return;
  }

  const path = requestPath(req);
  const target = new URL(`${base.pathname}/api/${path}`.replace(/\/+/g, '/'), base.origin);
  for (const [name, value] of Object.entries(req.query || {})) {
    if (name === 'path') continue;
    if (Array.isArray(value)) value.forEach(item => target.searchParams.append(name, String(item)));
    else if (value != null) target.searchParams.set(name, String(value));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), path === 'stream' ? 55_000 : 15_000);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: upstreamHeaders(req),
      body: upstreamBody(req),
      redirect: 'manual',
      signal: controller.signal,
    });

    res.status(upstream.status);
    for (const [name, value] of upstream.headers.entries()) {
      const lower = name.toLowerCase();
      if (!HOP_BY_HOP.has(lower) && lower !== 'content-encoding') res.setHeader(name, value);
    }
    res.setHeader('x-memebot-upstream', base.host);

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.status(error?.name === 'AbortError' ? 504 : 502).json({
        error: error?.name === 'AbortError' ? 'Railway API proxy timed out' : 'Railway API proxy failed',
        detail: String(error?.message || error),
      });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = handler;
module.exports.requestPath = requestPath;
