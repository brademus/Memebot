import http from 'http';
import { env } from './config';

export interface StandbyServer {
  close: () => Promise<void>;
}

/**
 * Keep Railway's replacement container healthy while the previous deployment still
 * owns the worker advisory lock. Once leadership becomes available, boot closes this
 * temporary listener and starts the full dashboard + scanner on the same port.
 */
export async function startStandbyServer(): Promise<StandbyServer> {
  const server = http.createServer((req, res) => {
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
  });

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
