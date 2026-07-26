import fs from 'fs';
import http from 'http';
import path from 'path';
import { env } from './config';
import { leadershipDiag } from './leadership';

export interface StandbyServer {
  close: () => Promise<void>;
}

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function sendFile(res: http.ServerResponse, filePath: string) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
    res.setHeader('content-type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.end(data);
  });
}

/**
 * Keep Railway's replacement container healthy while leadership is held elsewhere.
 * Serve the real dashboard shell directly instead of reverse-proxying through the
 * service's own private hostname, which can route back to this same standby and loop.
 */
export async function startStandbyServer(): Promise<StandbyServer> {
  const streams = new Set<http.ServerResponse>();
  const sockets = new Set<import('net').Socket>();
  const heartbeatTimers = new Map<http.ServerResponse, ReturnType<typeof setInterval>>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://standby.local');

    // EventSource requires a real text/event-stream response. Keep it connected while
    // standby is active, but use the default message event so the dashboard can render
    // the standby payload instead of looking disconnected.
    if (url.pathname === '/api/stream') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders?.();
      res.write(`data: ${JSON.stringify({
        tokens: [],
        scans: [],
        seenFeed: [],
        role: 'standby',
        scanning: false,
        message: 'Dashboard connected while the scanner acquires worker leadership',
        leadership: leadershipDiag(),
      })}\n\n`);
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': standby heartbeat\n\n');
      }, 10_000);
      heartbeat.unref();
      streams.add(res);
      heartbeatTimers.set(res, heartbeat);
      req.on('close', () => {
        clearInterval(heartbeat);
        heartbeatTimers.delete(res);
        streams.delete(res);
      });
      return;
    }

    if (url.pathname.startsWith('/api')) {
      res.statusCode = 200;
      res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        ok: true,
        role: 'standby',
        scanning: false,
        message: 'Dashboard is online while the scanner acquires worker leadership',
        leadership: leadershipDiag(),
      }));
      return;
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const normalized = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
    const candidate = path.join(PUBLIC_DIR, normalized);
    if (candidate.startsWith(PUBLIC_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      sendFile(res, candidate);
      return;
    }
    sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(env.PORT, () => {
      server.off('error', onError);
      console.log(`[standby] dashboard server listening on :${env.PORT}`);
      resolve();
    });
  });

  return {
    close: () => new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      };

      // End every long-lived EventSource response before closing the listener. Merely
      // calling server.close() waits indefinitely for these connections and prevents
      // boot.ts from ever starting the scanner worker.
      for (const [stream, heartbeat] of heartbeatTimers) {
        clearInterval(heartbeat);
        if (!stream.writableEnded) {
          stream.write('data: {"role":"promoting","scanning":false}\n\n');
          stream.end();
        }
      }
      heartbeatTimers.clear();
      streams.clear();

      server.close(error => finish(error));
      server.closeIdleConnections?.();

      // Railway/browser keep-alive sockets can survive response.end(). Force them down
      // after a brief drain so the active Express server can bind the port immediately.
      const forceTimer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.closeAllConnections?.();
      }, 250);
      forceTimer.unref();
    }),
  };
}
