import express from 'express';
import path from 'path';
import { env, cfg } from '../config';
import { activeTokens, allTokens, recentScans } from '../store';
import { pool } from '../db';
import { buildReport } from './report';
import { runAiReview } from '../ai/reviewer';
import { buildAnalytics } from './analytics';
import { rankToken } from '../scoring/rank';
import { currentBestBuys } from './bestbuys';
import { getStreamMode } from '../ingest/pumpfun';
import { fetchHistory, addSmartWallet, removeSmartWallet, listSmartWallets } from '../db';
import { latestSuggestion } from '../tuning/autotune';
import { TokenRecord } from '../types';

const clients = new Set<express.Response>();

export function startServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), 'public')));

  // full history from Postgres (everything ever seen), cursor-paged
  app.get('/api/history', async (req, res) => {
    const before = (req.query.before as string) || null;
    const rows = await fetchHistory(before, parseInt((req.query.limit as string) || '100', 10));
    res.json(rows);
  });

  // autotune's latest weight suggestion (apply manually in config.yaml)
  app.get('/api/tuning', (_req, res) => res.json(latestSuggestion()));

  // smart-wallet admin — write ops require ADMIN_KEY header
  app.get('/api/wallets', async (_req, res) => res.json(await listSmartWallets()));
  app.post('/api/wallets', async (req, res) => {
    if (!env.ADMIN_KEY || req.header('x-admin-key') !== env.ADMIN_KEY)
      return res.status(401).json({ error: 'set ADMIN_KEY env var and pass x-admin-key header' });
    const { wallet, type } = req.body || {};
    if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet))
      return res.status(400).json({ error: 'invalid wallet address' });
    try { await addSmartWallet(wallet, type || 'unspecified'); res.json({ ok: true, wallet }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  app.delete('/api/wallets/:wallet', async (req, res) => {
    if (!env.ADMIN_KEY || req.header('x-admin-key') !== env.ADMIN_KEY)
      return res.status(401).json({ error: 'unauthorized' });
    try { await removeSmartWallet(req.params.wallet); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

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

  // full history straight from Postgres — everything ever logged, paged
  app.get('/api/history', async (req, res) => {
    if (!pool) { res.json({ rows: [], note: 'no database attached' }); return; }
    const offset = parseInt(String(req.query.offset || '0'), 10) || 0;
    try {
      const r = await pool.query(
        `SELECT ca, symbol, name, source, first_seen, gate_result, gate_fail_reason, last_state, last_score
         FROM tokens ORDER BY first_seen DESC LIMIT 500 OFFSET $1`, [offset]);
      const c = await pool.query(`SELECT COUNT(*)::int AS n FROM tokens`);
      res.json({ total: c.rows[0].n, offset, rows: r.rows });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // weekly feedback report — JSON you paste back for tuning
  app.get('/api/report', async (_req, res) => {
    try { res.json(await buildReport()); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // tracked smart wallets, ranked by how many winners they hit
  app.get('/api/wallets', async (_req, res) => {
    if (!pool) { res.json({ rows: [] }); return; }
    try {
      const r = await pool.query(
        `SELECT wallet, type, winners_hit, active, discovered_from, last_validated
         FROM smart_wallets WHERE winners_hit > 0
         ORDER BY active DESC, winners_hit DESC LIMIT 100`);
      const c = await pool.query(`SELECT COUNT(*)::int n FROM smart_wallets WHERE active`);
      res.json({ active: c.rows[0].n, rows: r.rows });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // on-demand AI review: Pro model analyzes the bot's own performance, suggests config changes
  app.get('/api/ai-review', async (_req, res) => {
    try {
      const r = await runAiReview();
      res.json(r.review ? { review: r.review } : { note: 'GEMINI_API_KEY not set — review unavailable' });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/wins', async (_req, res) => {
    if (!pool) { res.json({ wins: [], note: 'attach Postgres to track wins' }); return; }
    try {
      const r = await pool.query(
        `SELECT t.ca, t.symbol, t.last_score, t.triggered_at, t.trigger_price,
                ROUND(MAX(o.multiple_from_first)::numeric, 2) AS best_multiple
         FROM tokens t JOIN outcomes o ON o.ca = t.ca
         WHERE t.triggered_at IS NOT NULL AND t.trigger_price > 0
         GROUP BY t.ca, t.symbol, t.last_score, t.triggered_at, t.trigger_price
         HAVING MAX(o.multiple_from_first) >= 1.5
         ORDER BY best_multiple DESC LIMIT 50`);
      // summary: hit rate of everything we triggered
      const summary = (await pool.query(
        `SELECT COUNT(DISTINCT t.ca) AS triggered,
                COUNT(DISTINCT t.ca) FILTER (WHERE m.best >= 2) AS won_2x,
                COUNT(DISTINCT t.ca) FILTER (WHERE m.best >= 5) AS won_5x
         FROM tokens t
         JOIN (SELECT ca, MAX(multiple_from_first) best FROM outcomes GROUP BY ca) m ON m.ca = t.ca
         WHERE t.triggered_at IS NOT NULL`)).rows[0];
      res.json({ wins: r.rows, summary });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/bestbuys', (_req, res) => {
    const buys = currentBestBuys();
    const watching = activeTokens().length;
    res.json({
      buys, watching,
      note: buys.length ? null
        : `0 of ${watching} watched clear the bar. Empty is normal — a coin that appears here has EARNED it and will hold its slot until it stops looking good.`,
    });
  });

  app.get('/api/analytics', async (_req, res) => {
    try { res.json(await buildAnalytics()); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // system status: which subsystems are live and why others aren't
  app.get('/api/status', async (_req, res) => {
    const { env } = require('../config');
    let walletCount = 0, lastDiscovery = null;
    if (pool) {
      try {
        const w = await pool.query(`SELECT COUNT(*)::int c FROM smart_wallets WHERE active`);
        walletCount = w.rows[0].c;
        const d = await pool.query(`SELECT MAX(last_validated) m FROM smart_wallets`);
        lastDiscovery = d.rows[0].m;
      } catch {}
    }
    res.json({
      db: !!pool,
      helius: !!env.HELIUS_API_KEY,
      gemini: !!env.GEMINI_API_KEY,
      telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      walletTracking: !!pool && !!env.HELIUS_API_KEY,
      tradeStream: getStreamMode(),
      activeWallets: walletCount,
      lastDiscovery,
    });
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
    smart: new Set(t.smartHits.map(h => h.wallet)).size,
    aiNote: t.aiNote,
    pair: t.pairAddress,
    rank: rankToken(t),
    play: t.playType,
    retention: t.earlyBuyers.length >= 5 ? +((1 - t.earlyExited.length / t.earlyBuyers.length)).toFixed(2) : null,
    socials: t.socials,
    devPct: +t.devBuyPct.toFixed(1),
  };
}
