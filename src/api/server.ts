import express from 'express';
import path from 'path';
import { env, cfg } from '../config';
import { activeTokens, allTokens, recentScans, hydration } from '../store';
import { pool } from '../db';
import { buildReport } from './report';
import { runAiReview } from '../ai/reviewer';
import { geminiLastError, geminiConfigured } from '../ai/gemini';
import { runSystemMonitor } from '../ai/monitor';
import { buildAnalytics } from './analytics';
import { buildCallsDashboard } from './calls';
import { rankToken } from '../scoring/rank';
import { assessEntryTiming, convictionQueueStatus, currentBestBuys } from './bestbuys';
import { getStreamMode } from '../ingest/pumpfun';
import { earlyBuyers } from '../helius';
import { discoveryDiag, runDiscovery } from '../wallets/discovery';
import { handleWebhook, webhookDiag } from '../wallets/webhook';
import { prefilterDiag } from '../gates/prefilter';
import { learningDiag } from '../tuning/filtertune';
import { scorecalDiag } from '../tuning/scorecal';
import { runPumpfunActivityMining, winnerMinerDiag } from '../wallets/winnerminer';
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

  app.post('/api/helius-webhook', (req, res) => {
    const code = handleWebhook(req.header('authorization'), req.body);
    res.status(code).end();
  });

  app.use('/api', publicApiLimit);

  app.use([
    '/api/tuning',
    '/api/report',
    '/api/system-monitor',
    '/api/ai-review',
    '/api/wallet-debug',
    '/api/discover',
    '/api/wallet-activity-mine',
    '/api/status',
    '/api/wallets',
    '/api/wallet-rankings',
  ], expensiveApiLimit, adminOnly);

  app.get('/api/tuning', (_req, res) => res.json(latestSuggestion()));

  app.get('/api/wallets', async (_req, res) => {
    try { res.json(await listSmartWallets()); }
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
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
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.delete('/api/wallets/:wallet', async (req, res) => {
    try {
      await removeSmartWallet(req.params.wallet);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/missed', async (_req, res) => {
    try { res.json(await getMissedWinners()); }
    catch (error) { res.json({ misses: [], summary: `missed-winners sweep failed: ${(error as Error).message}` }); }
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
        `SELECT ca,symbol,name,source,first_seen,gate_result,gate_fail_reason,last_state,last_score
           FROM tokens ORDER BY first_seen DESC LIMIT 500 OFFSET $1`, [offset]);
      const count = await pool.query(`SELECT COUNT(*)::int AS n FROM tokens`);
      res.json({ total: count.rows[0].n, offset, rows: rows.rows });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/report', async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '7'), 10) || 7));
      res.json(await buildReport(days));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/wallet-rankings', async (_req, res) => {
    if (!pool) { res.json({ active: 0, rows: [] }); return; }
    try {
      const rows = await pool.query(
        `SELECT wallet,type,winners_hit,active,discovered_from,last_validated,
                quality_verdict,win_rate,round_trips,last_active
           FROM smart_wallets
          ORDER BY active DESC,
                   CASE quality_verdict WHEN 'ELITE' THEN 0 WHEN 'GOOD' THEN 1 WHEN 'MARGINAL' THEN 2 ELSE 3 END,
                   winners_hit DESC,last_active DESC NULLS LAST
          LIMIT 150`);
      const count = await pool.query(`SELECT COUNT(*)::int n FROM smart_wallets WHERE active`);
      res.json({ active: count.rows[0].n, rows: rows.rows, diagnostics: winnerMinerDiag() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/system-monitor', async (_req, res) => {
    try {
      const all = allTokens();
      const snapshot = {
        funnel: {
          seenInMemory: all.length,
          gatedOutInMemory: all.filter(token => token.gated === false).length,
          watching: all.filter(token => token.gated === true && token.state !== 'DEAD').length,
          liveConvictions: currentBestBuys().length,
          liveTriggers: all.filter(token => token.state === 'TRIGGER').length,
          uptimeMin: Math.round(process.uptime() / 60),
          hydrated: hydration.restored,
          effectiveFloor: cfg().states.trigger_score_min,
          scoresNearFloor: all.filter(token => token.gated === true && token.score >= cfg().states.trigger_score_min - 10).length,
          maxScoreNow: Math.max(0, ...all.filter(token => token.gated === true).map(token => token.score)),
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
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
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
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/wins', async (_req, res) => {
    if (!pool) { res.json({ wins: [], note: 'attach Postgres to track wins' }); return; }
    try {
      const rows = await pool.query(`
        SELECT ca,symbol,signal,entry_at,entry_score,entry_price,execution_eligible,target_hit_at,
               ROUND((peak_price/NULLIF(entry_price,0))::numeric,2) AS best_multiple
          FROM paper_trades
         WHERE target_hit_at IS NOT NULL
         ORDER BY target_hit_at DESC LIMIT 100`);
      const summary = (await pool.query(`
        SELECT COUNT(*) FILTER (WHERE execution_eligible) AS executable_calls,
               COUNT(*) FILTER (WHERE execution_eligible AND closed
                 AND exit_reason IS DISTINCT FROM 'tracking_lost') AS resolved_calls,
               COUNT(*) FILTER (WHERE execution_eligible AND target_hit_at IS NOT NULL) AS won_3x,
               COUNT(*) FILTER (WHERE signal='trigger') AS trigger_observations,
               COUNT(*) FILTER (WHERE signal LIKE 'bb_%') AS conviction_observations,
               COUNT(*) FILTER (WHERE signal='conviction') AS legacy_post_alert_conviction_observations
          FROM paper_trades`)).rows[0];
      res.json({ wins: rows.rows, summary });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/calls', async (_req, res) => {
    try { res.json(await buildCallsDashboard()); }
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
  });

  app.get('/api/evidence', async (req, res) => {
    try {
      const days = Math.min(180, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
      res.json({ days, lanes: await paperScoreboard(days), diagnostics: await paperDiag() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/bestbuys', (_req, res) => {
    const buys = currentBestBuys();
    const watching = activeTokens().length;
    res.json({ buys, watching, note: buys.length ? null : `0 of ${watching} watched clear the conviction bar.` });
  });

  app.get('/api/analytics', analyticsLimit, async (_req, res) => {
    try { res.json(await buildAnalytics()); }
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
  });

  app.get('/api/wallet-debug', async (_req, res) => {
    const output: any = { helius_key_set: !!env.HELIUS_API_KEY, db: !!pool, activityMining: winnerMinerDiag() };
    if (!pool) { res.json(output); return; }
    const step = async (name: string, fn: () => Promise<any>) => {
      try { output[name] = await fn(); }
      catch (error) { output[name] = `ERROR: ${(error as Error).message}`; }
    };
    await step('pumpfun_trades_6h', async () =>
      (await pool!.query(`SELECT COUNT(*)::int c FROM trade_events WHERE source='pumpfun' AND at>now()-interval '6 hours'`)).rows[0].c);
    await step('active_pumpfun_wallets_6h', async () =>
      (await pool!.query(`SELECT COUNT(DISTINCT wallet)::int c FROM trade_events WHERE source='pumpfun' AND wallet IS NOT NULL AND at>now()-interval '6 hours'`)).rows[0].c);
    await step('smart_wallets_total', async () =>
      (await pool!.query(`SELECT COUNT(*)::int c FROM smart_wallets`)).rows[0].c);
    await step('smart_wallets_active', async () =>
      (await pool!.query(`SELECT COUNT(*)::int c FROM smart_wallets WHERE active`)).rows[0].c);
    await step('pumpfun_activity_promoted', async () =>
      (await pool!.query(`SELECT COUNT(*)::int c FROM smart_wallets WHERE active AND type='pumpfun_activity'`)).rows[0].c);
    await step('wallet_hits_total', async () =>
      (await pool!.query(`SELECT COUNT(*)::int c FROM wallet_hits`)).rows[0].c);
    await step('sample_winner_and_early_buyers', async () => {
      const result = await pool!.query(`SELECT t.ca,MAX(o.multiple_from_first) m
        FROM tokens t JOIN outcomes o ON o.ca=t.ca
        WHERE o.multiple_from_first>=3 AND t.first_seen>now()-interval '7 days'
        GROUP BY t.ca ORDER BY m DESC LIMIT 1`);
      if (!result.rows.length) return 'no winners yet';
      const ca = result.rows[0].ca;
      const buyers = await earlyBuyers(ca, 3);
      return { ca, best_multiple: result.rows[0].m, early_buyers_found: buyers.length, sample: buyers.slice(0, 3) };
    });
    output.verdict = !env.HELIUS_API_KEY ? 'HELIUS_API_KEY missing'
      : output.pumpfun_trades_6h === 0 ? 'Pump.fun trade stream has no recent rows'
      : output.smart_wallets_active === 0 ? 'activity exists but no wallet has cleared profitability validation'
      : 'pipeline healthy';
    res.json(output);
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
      jupiter: !!env.JUPITER_API_KEY,
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
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
  });

  app.get('/api/wallet-activity-mine', async (_req, res) => {
    try { res.json(await runPumpfunActivityMining()); }
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
  });

  app.get('/api/stats', async (_req, res) => {
    const all = allTokens();
    let lifetime = {
      seen: 0,
      killed: 0,
      passed: 0,
      triggered: 0,
      convictionSelections: 0,
      triggered24h: 0,
      convictionSelections24h: 0,
    };
    if (pool) {
      try {
        lifetime = (await pool.query(`
          SELECT COUNT(*)::int AS seen,
                 COUNT(*) FILTER (WHERE gate_result='failed')::int AS killed,
                 COUNT(*) FILTER (WHERE gate_result='passed')::int AS passed,
                 COUNT(*) FILTER (WHERE triggered_at IS NOT NULL)::int AS triggered,
                 COUNT(*) FILTER (WHERE conviction_at IS NOT NULL)::int AS "convictionSelections",
                 COUNT(*) FILTER (WHERE triggered_at>now()-interval '24 hours')::int AS "triggered24h",
                 COUNT(*) FILTER (WHERE conviction_at>now()-interval '24 hours')::int AS "convictionSelections24h"
            FROM tokens`)).rows[0];
      } catch {}
    }

    const convictions = currentBestBuys();
    res.json({
      seen: lifetime.seen || all.length,
      killed: lifetime.killed,
      passedTotal: lifetime.passed,
      triggeredTotal: lifetime.triggered,
      convictionSelectionsTotal: lifetime.convictionSelections,
      triggers24h: lifetime.triggered24h,
      convictionSelections24h: lifetime.convictionSelections24h,
      liveTriggers: all.filter(token => token.state === 'TRIGGER').length,
      liveConvictions: convictions.length,
      liveWatchlist: all.filter(token => token.gated === true && token.state !== 'DEAD').length,
      liveInMemory: all.length,
      gatedOut: lifetime.killed || all.filter(token => token.gated === false).length,
      watching: all.filter(token => token.gated === true && token.state !== 'DEAD').length,
      triggers: all.filter(token => token.state === 'TRIGGER').length,
      lifecycle: {
        watchlist: all.filter(token => token.gated === true && token.state !== 'DEAD').length,
        convictions: convictions.length,
        currentCalls: all.filter(token => token.state === 'TRIGGER').length,
      },
      funnel: funnelSnapshot(all),
    });
  });

  app.listen(env.PORT, () => console.log(`[api] dashboard on :${env.PORT}`));
}

function funnelSnapshot(all: TokenRecord[]) {
  const settings = cfg().states;
  const gated = all.filter(token => token.gated === true && !['DEAD', 'DYING', 'EXTENDED'].includes(token.state));
  const blocked = { lowScore: 0, lowRatio: 0, fewTrades: 0, tooYoung: 0, triggering: 0, convictions: 0 };
  for (const token of gated) {
    const ageMin = (Date.now() - token.firstSeen) / 60_000;
    const ratio = token.sells5m > 0 ? token.buys5m / token.sells5m : (token.buys5m > 0 ? 3 : 1);
    if (token.state === 'TRIGGER') { blocked.triggering++; continue; }
    if (convictionQueueStatus(token.ca).queued) blocked.convictions++;
    if (token.score < settings.trigger_score_min) blocked.lowScore++;
    else if (ratio < settings.trigger_buy_ratio_min) blocked.lowRatio++;
    else if ((token.buys5m + token.sells5m) < settings.trigger_min_trades) blocked.fewTrades++;
    else if (ageMin < settings.early_runner_min_age) blocked.tooYoung++;
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
    .sort((left, right) => right.firstSeen - left.firstSeen)
    .slice(0, 150)
    .map(token => ({
      ca: token.ca,
      symbol: token.symbol,
      source: token.source,
      status: token.gated === null ? 'PENDING' : token.gated === false ? 'KILLED' : token.state,
      reason: token.gateFailReason,
      ageMin: Math.round((Date.now() - token.firstSeen) / 60_000),
      liq: Math.round(token.liquidityUsd),
      score: token.gated === true ? token.score : null,
    }));
}

const STATE_ORDER: Record<string, number> = { TRIGGER: 0, HEATING: 1, WATCHING: 2, EXTENDED: 3, DYING: 4 };

function serialize() {
  return activeTokens()
    .sort((left, right) => (STATE_ORDER[left.state] ?? 9) - (STATE_ORDER[right.state] ?? 9) || right.score - left.score)
    .map(pick);
}

function pick(token: TokenRecord) {
  const conviction = convictionQueueStatus(token.ca);
  const entry = conviction.queued ? assessEntryTiming(token, Date.now(), conviction) : null;
  return {
    ca: token.ca,
    symbol: token.symbol,
    name: token.name,
    source: token.source,
    state: token.state,
    score: token.score,
    subs: token.subs,
    ageMin: Math.round((Date.now() - token.firstSeen) / 60_000),
    priceUsd: token.priceUsd,
    liq: Math.round(token.liquidityUsd),
    mcap: Math.round(token.mcapUsd),
    ratio: token.mcapUsd > 0 ? +(token.liquidityUsd / token.mcapUsd).toFixed(3) : 0,
    buys: token.buys5m,
    sells: token.sells5m,
    chg5m: token.priceChange5m,
    movedPct: token.firstScorePrice && token.priceUsd ? +(((token.priceUsd / token.firstScorePrice) - 1) * 100).toFixed(1) : 0,
    insider: token.bundle ? token.bundle.insiderPct : null,
    funded: token.bundle ? token.bundle.fundedSnipers : 0,
    smart: new Set(token.smartHits.map(hit => hit.wallet)).size,
    smartElite: token.smartHits.some(hit => (hit.w || 1) > 1),
    aiNote: token.aiNote,
    pair: token.pairAddress,
    rank: rankToken(token),
    play: token.playType,
    retention: token.earlyBuyers.length >= 5 ? +((1 - token.earlyExited.length / token.earlyBuyers.length)).toFixed(2) : null,
    socials: token.socials,
    devPct: +token.devBuyPct.toFixed(1),
    conviction: conviction.queued,
    convictionLane: conviction.lane,
    convictionHeldSeconds: Math.round(conviction.heldSeconds),
    convictionMinimumHoldSeconds: conviction.minimumHoldSeconds,
    convictionHoldReady: conviction.holdReady,
    entryReady: entry?.ready ?? false,
    entryBlockers: entry?.blockers ?? [],
    aiRead: token.aiConviction ? {
      verdict: token.aiConviction.verdict,
      delta: token.aiConviction.delta,
      reason: token.aiConviction.reason,
    } : null,
    boost: token.boostAmount || 0,
    tgGrowth: token.tgGrowthPerMin || 0,
  };
}
