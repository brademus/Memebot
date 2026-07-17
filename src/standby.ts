import http from 'http';
import { env } from './config';
import { readLeaderAddress } from './leadership';

// cache the leader address briefly so we don't hit Postgres per request
let cachedAddr: string | null = null;
let cachedAt = 0;
async function leaderAddr(): Promise<string | null> {
  if (Date.now() - cachedAt < 20_000) return cachedAddr;
  cachedAddr = await readLeaderAddress();
  cachedAt = Date.now();
  return cachedAddr;
}

export interface StandbyServer {
  close: () => Promise<void>;
}

/**
 * Keep Railway's replacement container healthy while the previous deployment still
 * owns the worker advisory lock. Once leadership becomes available, boot closes this
 * temporary listener and starts the full dashboard + scanner on the same port.
 */
export async function startStandbyServer(): Promise<StandbyServer> {
  const server = http.createServer(async (req, res) => {
    // REVERSE PROXY: if the leader has published its private address, forward the
    // request to it over Railway's internal network. The public domain then serves
    // the REAL dashboard no matter which instance holds leadership. Any proxy
    // failure falls back to the stub below, so Railway healthchecks never fail.
    const addr = await leaderAddr().catch(() => null);
    if (addr) {
      const [host, port] = addr.split(':');
      const forwarded = http.request(
        { host, port: Number(port) || 8080, path: req.url, method: req.method, headers: { ...req.headers, host: `${host}:${port}` }, family: 0, timeout: 25_000 },
        upstream => { res.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(res); });
      forwarded.on('error', () => { if (!res.headersSent) stub(req, res); });
      forwarded.on('timeout', () => forwarded.destroy());
      req.pipe(forwarded);
      return;
    }
    stub(req, res);
  });

  function stub(req: http.IncomingMessage, res: http.ServerResponse) {
    const api = req.url?.startsWith('/api');
    res.statusCode = 200;
    res.setHeader('cache-control', 'no-store');
    if (api) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        ok: true,
        role: 'standby',
        scanning: false,
        message: 'Waiting to acquire worker leadership',
      }));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Memewatch standby</title><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;background:#090b10;color:#f5f7ff;padding:32px"><h1>Memewatch is promoting a scanner worker</h1><p>This deployment is healthy and waiting for the previous worker to release leadership. It retries automatically.</p></body>');
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(env.PORT, () => {
      server.off('error', onError);
      console.log(`[standby] health server listening on :${env.PORT}`);
      resolve();
    });
  });

  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
