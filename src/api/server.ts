import express from 'express';
import path from 'path';
import { env, cfg } from '../config';
import { activeTokens, allTokens, recentScans, hydration } from '../store';
import { checkConviction, convictionFiredToday } from '../scoring/conviction';
import { pool } from '../db';
import { buildReport } from './report';
import { runAiReview } from '../ai/reviewer';
import { geminiLastError, geminiConfigured } from '../ai/gemini';
import { runSystemMonitor } from '../ai/monitor';
import { buildAnalytics } from './analytics';
import { rankToken } from '../scoring/rank';
import { currentBestBuys } from './bestbuys';
import { getStreamMode } from '../ingest/pumpfun';
import { earlyBuyers } from '../helius';
import { discoveryDiag, runDiscovery } from '../wallets/discovery';
import { handleWebhook, webhookDiag } from '../wallets/webhook';
import { prefilterDiag } from '../gates/prefilter';
import { learningDiag } from '../tuning/filtertune';
import { scorecalDiag } from '../tuning/scorecal';
import { winnerMinerDiag } from '../wallets/winnerminer';
import { triggerAutopsy } from '../scoring/states';
import { paperScoreboard, paperDiag } from '../paper/paper';
import { momentumDiag } from '../ingest/momentum';
import { socialDiag } from '../ingest/social';
import { heliusHealth } from '../helius';
import { getMissedWinners } from '../outcomes/missed';
import { addSmartWallet, removeSmartWallet, listSmartWallets } from '../db';
import { latestSuggestion } from '../tuning/autotune';
import { TokenRecord } from '../types';
import { adminOnly, expensiveApiLimit, publicApiLimit, rateLimit, streamConnectLimit } from './security';

const clients = new Set<express.Response>();
const analyticsLimit = rateLimit('analytics', 12, 60_000);

export function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Helius has its own per-boot authorization and must not share browser limits.
  app.post('/api/helius-webhook', (req, res) => {
    const code = handleWebhook(req.header('authorization'), req.body);
    res.status(code).end();
  });

  app.use('/api', publicApiLimit);

  // Expensive diagnostics and strategy internals are private. Both a bearer token
  // and x-admin-key are accepted; comparisons use timing-safe equality.
  app.use([
    '/api/tuning',
    '/api/report',
    '/api/system-monitor',
    '/api/ai-review',
    '/api/wallet-debug',
    '/api/discover',
    '/api/status',
    '/api/wallets',
    '/api/wallet-rankings',
  ], expensiveApiLimit, adminOnly);

  app.get('/api/tuning', (_req, res) => res.json(latestSuggestion()));

  app.get('/api/wallets', async (_req, res) => {
    try { res.json(await listSmartWallets()); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/wallets', async (req, res) => {
    const { wallet, type } = req.body || {};
    if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      res.status(400).json({ error: 'invalid wallet address' });
      return;
    }
    try {
      await addSmartWallet(wallet, type || 'unspecified');
      res.json({ ok: true, wallet });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.delete('/api/wallets/:wallet', async (req, res) => {
    try {
      await removeSmartWallet(req.params.wallet);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/missed', async (_req, res) => {
    try { res.json(await getMissedWinners()); }
    catch (e) { res.json({ misses: [], summary: `missed-winners sweep failed: ${(e as Error).message}` }); }
  });

  app.get('/api/tokens', (_req, res) => res.json(payload()));

  app.get('/api/stream', streamConnectLimit, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(payload())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  app.get('/api/history', async (req, res) => {
    if (!pool) { res.json({ rows: [], note: 'no database attached' }); return; }
    const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
    try {
      const rows = await pool.query(
        `SELECT ca, symbol, name, source, first_seen, gate_result, gate_fail_reason, last_state, last_score
           FROM tokens ORDER BY first_seen DESC LIMIT 500 OFFSET $1`, [offset]);
      const count = await pool.query(`SELECT COUNT(*)::int AS n FROM tokens`);
      res.json({ total: count.rows[0].n, offset, rows: rows.rows });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/report', async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '7'), 10) || 7));
      res.json(await buildReport(days));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/wallet-rankings', async (_req, res) => {
    if (!pool) { res.json({ active: 0, rows: [] }); return; }
    try {
      const rows = await pool.query(
        `SELECT wallet, type, winners_hit, active, discovered_from, last_validated
           FROM smart_wallets WHERE winners_hit > 0
          ORDER BY active DESC, winners_hit DESC LIMIT 100`);
      const count = await pool.query(`SELECT COUNT(*)::int n FROM smart_wallets WHERE active`);
      res.json({ active: count.rows[0].n, rows: rows.rows });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/system-monitor', async (_req, res) => {
    try {
      const all = allTokens();
      const snapshot = {
        funnel: {
          seenInMemory: all.length,
          gatedOutInMemory: all.filter(t => t.gated === false).length,
          watching: all.filter(t => t.gated === true && t.state !== 'DEAD').length,
          liveTriggers: all.filter(t => t.state === 'TRIGGER').length,
          uptimeMin: Math.round(process.uptime() / 60),
          hydrated: hydration.restored,
          effectiveFloor: cfg().states.trigger_score_min,
          scoresNearFloor: all.filter(t => t.gated === true && t.score >= cfg().states.trigger_score_min - 10).length,
          maxScoreNow: Math.max(0, ...all.filter(t => t.gated === true).map(t => t.score)),
        },
        subsystems: {
          webhook: webhookDiag(),
          helius: heliusHealth(),
          calibration: scorecalDiag(),
          learning: learningDiag(),
          momentum: momentumDiag(),
          social: socialDiag(),
          winnerMiner: winnerMinerDiag(),
          discovery: discoveryDiag(),
          gemini: { configured: geminiConfigured(), lastError: geminiLastError() },
          triggerAutopsy: triggerAutopsy(),
          paper: await paperDiag(),
          streamMode: getStreamMode(),
        },
      };
      const result = await runSystemMonitor(snapshot);
      res.json(result.read ? { read: result.read, snapshot } : { note: result.note, snapshot });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/ai-review', async (_req, res) => {
    try {
      const result = await runAiReview();
      if (result.review) { res.json({ review: result.review }); return; }
      const reason = !geminiConfigured()
        ? 'GEMINI_API_KEY is not configured'
        : (geminiLastError() || 'the model returned no content');
      res.json({ note: `AI review unavailable: ${reason}` });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/wins', async (_req, res) => {
    if (!pool) { res.json({ wins: [], note: 'attach Postgres to track wins' }); return; }
    try {
      const rows = await pool.query(`
        SELECT ca, symbol, signal, entry_at, entry_score, entry_price,
               execution_eligible, target_hit_at,
               ROUND((peak_price / NULLIF(entry_price,0))::numeric, 2) AS best_multiple
          FROM paper_trades
         WHERE target_hit_at IS NOT NULL
         ORDER BY target_hit_at DESC LIMIT 100`);
      const summary = (await pool.query(`
        SELECT COUNT(*) FILTER (WHERE execution_eligible) AS executable_calls,
               COUNT(*) FILTER (WHERE execution_eligible AND closed
                 AND exit_reason IS DISTINCT FROM 'tracking_lost') AS resolved_calls,
               COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL) AS won_3x,
               COUNT(*) FILTER (WHERE signal='trigger') AS trigger_observations,
               COUNT(*) FILTER (WHERE signal='conviction') AS conviction_observations
          FROM paper_trades`)).rows[0];
      res.json({ wins: rows.rows, summary });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/evidence', async (req, res) => {
    try {
      const days = Math.min(180, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
      res.json({ days, lanes: await paperScoreboard(days), diagnostics: await paperDiag() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/bestbuys', (_req, res) => {
    const buys = currentBestBuys();
    const watching = activeTokens().length;
    res.json({
      buys,
      watching,
      note: buys.length ? null : `0 of ${watching} watched clear the opportunity bar.`,
    });
  });

  app.get('/api/analytics', analyticsLimit, async (_req, res) => {
    try { res.json(await buildAnalytics()); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/wallet-debug', async (_req, res) => {
    const out: any = { helius_key_set: !!env.HELIUS_API_KEY, db: !!pool };
    if (!pool) { res.json(out); return; }
    const step = async (name: string, fn: () => Promise<any>) => {
      try { out[name] = await fn(); }
      catch (e) { out[name] = `ERROR: ${(e as Error).message}`; }
    };
    await step('winners_3x_last7d', async () =>
      (await pool!.query(`SELECT COUNT(DISTINCT t.ca)::int c FROM tokens t JOIN outcomes o ON o.ca=t.ca
        WHERE o.multiple_from_first >= 3 AND t.first_seen > now() - interval '7 days'`)).rows[0].c);
    await step('winners_unmined', async () =>
      (await pool!.query(`SELECT COUNT(DISTINCT t.ca)::int c FROM tokens t JOIN outcomes o ON o.ca=t.ca
        WHERE o.multiple_from_first >= 3 AND t.first_seen > now() - interval '7 days'
          AND t.mined_at IS NULL`)).rows[0].c);
    await step('sample_winner_and_early_buyers', async () => {
      const result = await pool!.query(`SELECT t.ca, MAX(o.multiple_from_first) m
        FROM tokens t JOIN outcomes o ON o.ca=t.ca
        WHERE o.multiple_from_first >= 3 AND t.first_seen > now() - interval '7 days'
        GROUP BY t.ca ORDER BY m DESC LIMIT 1`);
      if (!result.rows.length) return 'no winners yet';
      const ca = result.rows[0].ca;
      const buyers = await earlyBuyers(ca, 3);
      return { ca, best_multiple: result.rows[0].m, early_buyers_found: buyers.length, sample: buyers.slice(0, 3) };
    });
    await step('smart_wallets_total', async () =>
      (await pool!.query(`SELECT COUNT(*)::int c FROM smart_wallets`)).rows[0].c);
    await step('smart_wallets_active', async () =>
      (await pool!.query(`SELECT COUNT(*)::int c FROM smart_wallets WHERE active`)).rows[0].c);
    await step('wallet_hits_total', async () =>
      (await pool!.query(`SELECT COUNT(*)::int c FROM wallet_hits`)).rows[0].c);
    out.verdict = !env.HELIUS_API_KEY ? 'HELIUS_API_KEY missing'
      : out.winners_3x_last7d === 0 ? 'no 3x winners logged yet'
      : typeof out.sample_winner_and_early_buyers === 'object' && out.sample_winner_and_early_buyers.early_buyers_found === 0
        ? 'Helius returned no early buyers'
        : out.smart_wallets_total === 0 ? 'winner buyers exist but wallet inserts are missing'
        : 'pipeline healthy';
    res.json(out);
  });

  app.get('/api/status', async (_req, res) => {
    let walletCount = 0;
    let lastDiscovery: unknown = null;
    if (pool) {
      try {
        walletCount = (await pool.query(`SELECT COUNT(*)::int c FROM smart_wallets WHERE active`)).rows[0].c;
        lastDiscovery = (await pool.query(`SELECT MAX(last_validated) m FROM smart_wallets`)).rows[0].m;
      } catch {}
    }
    res.json({
      db: !!pool,
      helius: !!env.HELIUS_API_KEY,
      gemini: !!env.GEMINI_API_KEY,
      jupiter: !!process.env.JUPITER_API_KEY,
      geminiError: geminiLastError(),
      telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      walletTracking: !!pool && !!env.HELIUS_API_KEY,
      tradeStream: getStreamMode(),
      activeWallets: walletCount,
      lastDiscovery,
      discovery: discoveryDiag(),
      webhook: webhookDiag(),
      prefilter: prefilterDiag(),
      learning: learningDiag(),
      calibration: scorecalDiag(),
      winnerMiner: winnerMinerDiag(),
      momentum: momentumDiag(),
      social: socialDiag(),
      heliusHealth: heliusHealth(),
      paper: await paperDiag(),
    });
  });

  app.get('/api/discover', async (_req, res) => {
    try { res.json(await runDiscovery()); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/stats', async (_req, res) => {
    const all = allTokens();
    let lifetime = {
      seen: 0,
      killed: 0,
      passed: 0,
      triggered: 0,
      convictions: 0,
      triggered24h: 0,
      convictions24h: 0,
    };
    if (pool) {
      try {
        lifetime = (await pool.query(`
          SELECT COUNT(*)::int AS seen,
                 COUNT(*) FILTER (WHERE gate_result='failed')::int AS killed,
                 COUNT(*) FILTER (WHERE gate_result='passed')::int AS passed,
                 COUNT(*) FILTER (WHERE triggered_at IS NOT NULL)::int AS triggered,
                 COUNT(*) FILTER (WHERE conviction_at IS NOT NULL)::int AS convictions,
                 COUNT(*) FILTER (WHERE triggered_at > now()-interval '24 hours')::int AS triggered24h,
                 COUNT(*) FILTER (WHERE conviction_at > now()-interval '24 hours')::int AS convictions24h
            FROM tokens`)).rows[0];
      } catch {}
    }

    const opportunities = currentBestBuys();
    const liveConfirmed = all.filter(t => t.convictionAt !== null && !['DYING','DEAD','EXTENDED'].includes(t.state));
    res.json({
      seen: lifetime.seen || all.length,
      killed: lifetime.killed,
      passedTotal: lifetime.passed,
      triggeredTotal: lifetime.triggered,
      confirmedConvictionsTotal: lifetime.convictions,
      triggers24h: lifetime.triggered24h,
      confirmedConvictions24h: lifetime.convictions24h,
      liveTriggers: all.filter(t => t.state === 'TRIGGER').length,
      liveConfirmedConvictions: liveConfirmed.length,
      liveOpportunitySlots: opportunities.length,
      liveWatchlist: all.filter(t => t.gated === true && t.state !== 'DEAD').length,
      liveInMemory: all.length,
      // Compatibility fields are explicit in meaning now.
      gatedOut: lifetime.killed || all.filter(t => t.gated === false).length,
      watching: all.filter(t => t.gated === true && t.state !== 'DEAD').length,
      triggers: all.filter(t => t.state === 'TRIGGER').length,
      convictionsToday: convictionFiredToday(),
      convictionBudget: cfg().conviction?.max_alerts_per_day ?? 5,
      funnel: funnelSnapshot(all),
    });
  });

  app.listen(env.PORT, () => console.log(`[api] dashboard on :${env.PORT}`));
}

function funnelSnapshot(all: TokenRecord[]) {
  const s = cfg().states;
  const gated = all.filter(t => t.gated === true && !['DEAD','DYING','EXTENDED'].includes(t.state));
  const blocked = { lowScore: 0, lowRatio: 0, fewTrades: 0, tooYoung: 0, triggering: 0 };
  for (const t of gated) {
    const ageMin = (Date.now() - t.firstSeen) / 60_000;
    const ratio = t.sells5m > 0 ? t.buys5m / t.sells5m : (t.buys5m > 0 ? 3 : 1);
    if (t.state === 'TRIGGER') { blocked.triggering++; continue; }
    if (t.score < s.trigger_score_min) blocked.lowScore++;
    else if (ratio < s.trigger_buy_ratio_min) blocked.lowRatio++;
    else if ((t.buys5m + t.sells5m) < s.trigger_min_trades) blocked.fewTrades++;
    else if (ageMin < s.early_runner_min_age) blocked.tooYoung++;
  }
  return { gatedActive: gated.length, ...blocked };
}

export function broadcast() {
  if (!clients.size) return;
  const message = `data: ${JSON.stringify(payload())}\n\n`;
  for (const client of clients) client.write(message);
}

const payload = () => ({ tokens: serialize(), scans: recentScans().slice(0, 60), seenFeed: seenFeed() });

function seenFeed() {
  return allTokens()
    .sort((a, b) => b.firstSeen - a.firstSeen)
    .slice(0, 150)
    .map(t => ({
      ca: t.ca,
      symbol: t.symbol,
      source: t.source,
      status: t.gated === null ? 'PENDING' : t.gated === false ? 'KILLED' : t.state,
      reason: t.gateFailReason,
      ageMin: Math.round((Date.now() - t.firstSeen) / 60_000),
      liq: Math.round(t.liquidityUsd),
      score: t.gated === true ? t.score : null,
    }));
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
    ca: t.ca,
    symbol: t.symbol,
    name: t.name,
    source: t.source,
    state: t.state,
    score: t.score,
    subs: t.subs,
    ageMin: Math.round((Date.now() - t.firstSeen) / 60_000),
    priceUsd: t.priceUsd,
    liq: Math.round(t.liquidityUsd),
    mcap: Math.round(t.mcapUsd),
    ratio: t.mcapUsd > 0 ? +(t.liquidityUsd / t.mcapUsd).toFixed(3) : 0,
    buys: t.buys5m,
    sells: t.sells5m,
    chg5m: t.priceChange5m,
    movedPct: t.firstScorePrice && t.priceUsd ? +(((t.priceUsd / t.firstScorePrice) - 1) * 100).toFixed(1) : 0,
    insider: t.bundle ? t.bundle.insiderPct : null,
    funded: t.bundle ? t.bundle.fundedSnipers : 0,
    smart: new Set(t.smartHits.map(h => h.wallet)).size,
    smartElite: t.smartHits.some(h => (h.w || 1) > 1),
    aiNote: t.aiNote,
    pair: t.pairAddress,
    rank: rankToken(t),
    play: t.playType,
    retention: t.earlyBuyers.length >= 5 ? +((1 - t.earlyExited.length / t.earlyBuyers.length)).toFixed(2) : null,
    socials: t.socials,
    devPct: +t.devBuyPct.toFixed(1),
    conviction: t.convictionAt !== null,
    aiRead: t.aiConviction ? {
      verdict: t.aiConviction.verdict,
      delta: t.aiConviction.delta,
      reason: t.aiConviction.reason,
    } : null,
    boost: t.boostAmount || 0,
    tgGrowth: t.tgGrowthPerMin || 0,
    convictionMissing: t.state === 'TRIGGER' && t.convictionAt === null
      ? checkConviction(t).missing : null,
  };
}
