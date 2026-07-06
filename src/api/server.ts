import express from 'express';
import path from 'path';
import { env } from '../config';
import { activeTokens, allTokens, recentScans } from '../store';
import { TokenRecord } from '../types';

const clients = new Set<express.Response>();

export function startServer() {
  const app = express();
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/api/tokens', (_req, res) => res.json(payload()));

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(payload())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  app.get('/api/stats', (_req, res) => {
    const all = allTokens();
    res.json({
      seen: all.length,
      gatedOut: all.filter(t => t.gated === false).length,
      watching: all.filter(t => t.gated === true && t.state !== 'DEAD').length,
      triggers: all.filter(t => t.state === 'TRIGGER').length,
    });
  });

  app.listen(env.PORT, () => console.log(`[api] dashboard on :${env.PORT}`));
}

// push to all SSE clients — call after each scoring pass
export function broadcast() {
  if (!clients.size) return;
  const msg = `data: ${JSON.stringify(payload())}\n\n`;
  for (const c of clients) c.write(msg);
}

const payload = () => ({ tokens: serialize(), scans: recentScans().slice(0, 60), seenFeed: seenFeed() });

// Every token in the store, newest first, with whatever status it currently has.
// This is the raw "everything that came through" view — including tokens still
// pending gates (no liquidity yet) that never appear in the watchlist or scan feed.
function seenFeed() {
  return allTokens()
    .sort((a, b) => b.firstSeen - a.firstSeen)
    .slice(0, 150)
    .map(t => {
      let status: string;
      if (t.gated === null) status = 'PENDING';        // seen, waiting for liquidity to run gates
      else if (t.gated === false) status = 'KILLED';
      else status = t.state;                            // WATCHING/HEATING/TRIGGER/etc.
      return {
        ca: t.ca, symbol: t.symbol, source: t.source, status,
        reason: t.gateFailReason,
        ageMin: Math.round((Date.now() - t.firstSeen) / 60000),
        liq: Math.round(t.liquidityUsd),
        score: t.gated === true ? t.score : null,
      };
    });
}

const STATE_ORDER: Record<string, number> = { TRIGGER: 0, HEATING: 1, WATCHING: 2, EXTENDED: 3, DYING: 4 };

function serialize() {
  return activeTokens()
    .sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || b.score - a.score)
    .slice(0, 50)
    .map(pick);
}

function pick(t: TokenRecord) {
  return {
    ca: t.ca, symbol: t.symbol, name: t.name, source: t.source, state: t.state,
    score: t.score, subs: t.subs,
    ageMin: Math.round((Date.now() - t.firstSeen) / 60000),
    priceUsd: t.priceUsd, liq: Math.round(t.liquidityUsd), mcap: Math.round(t.mcapUsd),
    ratio: t.mcapUsd > 0 ? +(t.liquidityUsd / t.mcapUsd).toFixed(3) : 0,
    buys: t.buys5m, sells: t.sells5m, chg5m: t.priceChange5m,
    movedPct: t.firstScorePrice && t.priceUsd ? +(((t.priceUsd / t.firstScorePrice) - 1) * 100).toFixed(1) : 0,
    insider: t.bundle ? t.bundle.insiderPct : null,
    funded: t.bundle ? t.bundle.fundedSnipers : 0,
    pair: t.pairAddress,
  };
}
