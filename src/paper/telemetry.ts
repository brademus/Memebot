import { cfg } from '../config';
import { pool } from '../db';
import { pumpfunStreamDiag, getStreamMode } from '../ingest/pumpfun';
import { burstFeatures } from '../model/burst';
import { rankToken } from '../scoring/rank';
import { TokenRecord } from '../types';
import { weightedSmartHits } from '../wallets/tracker';

export interface PaperTelemetryContext {
  conviction?: unknown;
  triggerAssessment?: unknown;
  lifecycle?: Record<string, unknown>;
}

export interface PaperSnapshotRow {
  id: number;
  ca: string;
  signal: string;
  model_version: string;
  entry_price: number | string;
  entry_at: string | Date;
  peak_price?: number | string | null;
  trough_price?: number | string | null;
}

const finite = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const ratio = (buys: number, sells: number): number => sells > 0 ? buys / sells : buys > 0 ? buys : 1;

export function telemetryCadenceSeconds(ageSeconds: number): number {
  if (ageSeconds < 10 * 60) return 15;
  if (ageSeconds < 60 * 60) return 30;
  if (ageSeconds < 4 * 60 * 60) return 120;
  return 300;
}

export function telemetryBucketSeconds(ageSeconds: number): number {
  const cadence = telemetryCadenceSeconds(ageSeconds);
  return Math.floor(Math.max(0, ageSeconds) / cadence) * cadence;
}

export function telemetryPhase(ageSeconds: number): string {
  if (ageSeconds < 10 * 60) return 'entry_discovery';
  if (ageSeconds < 60 * 60) return 'early_followthrough';
  if (ageSeconds < 4 * 60 * 60) return 'trend_resolution';
  return 'long_tail';
}

function observedTradeEvents(token: TokenRecord, now: number): number {
  return token.recentTrades.filter(event => event.at >= now - 5 * 60_000).length;
}

function coverageSnapshot(token: TokenRecord, now: number) {
  const exactEvents = observedTradeEvents(token, now);
  const stream = pumpfunStreamDiag();
  const coverage = {
    price: token.priceUsd > 0,
    liquidity: token.liquidityUsd > 0,
    marketCap: token.mcapUsd > 0,
    aggregateFlow: token.buys5m + token.sells5m > 0,
    exactTradeEvents: exactEvents > 0,
    walletIdentities: token.recentTrades.some(event => !!event.wallet),
    tradeAmounts: token.recentTrades.some(event => Number(event.solAmount) > 0 || Number(event.tokenAmount) > 0),
    socialsFetched: token.socials.fetched,
    bundleMeasured: token.bundle !== null,
    entityGraphComplete: token.entityGraph?.complete === true,
    modelDecision: token.modelDecision !== null,
    executionEvidence: token.modelDecision?.execution !== null && token.modelDecision?.execution !== undefined,
    streamConfigured: stream.configured,
    streamConnected: stream.connected,
    streamMode: stream.effectiveMode,
  };
  return {
    ...coverage,
    missing: Object.entries(coverage).filter(([, present]) => present === false).map(([name]) => name),
    stream,
  };
}

function fullTokenSnapshot(token: TokenRecord, now: number) {
  const smart = weightedSmartHits(token.smartHits, cfg().wallets.hit_recency_hours * 3600_000, now);
  const earlyRetention = token.earlyBuyers.length
    ? 1 - token.earlyExited.length / token.earlyBuyers.length
    : null;
  return {
    identity: {
      ca: token.ca,
      symbol: token.symbol,
      name: token.name,
      creator: token.creator,
      source: token.source,
      pairAddress: token.pairAddress,
      dex: token.dex,
      dexId: token.dexId,
      playType: token.playType,
    },
    timing: {
      firstSeen: token.firstSeen,
      ageSeconds: Math.max(0, Math.round((now - token.firstSeen) / 1000)),
      convictionAt: token.convictionAt,
      triggeredAt: token.triggeredAt,
      stateChangedAt: token.stateChangedAt,
      gradAt: token.gradAt,
      fillMinutes: token.fillMinutes,
      secondWaveAt: token.secondWaveAt,
      utcHour: new Date(now).getUTCHours(),
      utcDay: new Date(now).getUTCDay(),
    },
    market: {
      priceUsd: token.priceUsd,
      firstScorePrice: token.firstScorePrice,
      triggerPrice: token.triggerPrice,
      liquidityUsd: token.liquidityUsd,
      mcapUsd: token.mcapUsd,
      liquidityMcapRatio: token.mcapUsd > 0 ? token.liquidityUsd / token.mcapUsd : null,
      vol5m: token.vol5m,
      priceChange5m: token.priceChange5m,
      movedFromFirstScorePct: token.firstScorePrice && token.priceUsd > 0
        ? (token.priceUsd / token.firstScorePrice - 1) * 100 : null,
    },
    flow: {
      buys5m: token.buys5m,
      sells5m: token.sells5m,
      buySellRatio: ratio(token.buys5m, token.sells5m),
      totalBuys: token.totalBuys,
      totalSells: token.totalSells,
      uniqueBuyers: token.uniqueBuyers.length,
      uniqueBuyerSamples: token.uniqueBuyerSamples.slice(-60),
      exactEvents5m: observedTradeEvents(token, now),
      recentTradeTail: token.recentTrades.slice(-200),
    },
    curve: {
      curveSol: token.curveSol,
      peakCurveSol: token.peakCurveSol,
      curveSamples: token.curveSamples.slice(-120),
      gradPeak: token.gradPeak,
      gradTrough: token.gradTrough,
    },
    scoring: {
      score: token.score,
      peakScore: token.peakScore,
      lastAlertScore: token.lastAlertScore,
      subs: token.subs,
      state: token.state,
    },
    safety: {
      gated: token.gated,
      gateFailReason: token.gateFailReason,
      insiderKilled: token.insiderKilled,
      devBuyPct: token.devBuyPct,
      bundle: token.bundle,
      entityGraph: token.entityGraph,
      deployerRep: token.deployerRep,
      earlyBuyers: token.earlyBuyers.slice(-300),
      earlyExited: token.earlyExited.slice(-300),
      earlyRetention,
    },
    social: {
      ...token.socials,
      description: token.description,
      boostAmount: token.boostAmount,
      tgGrowthPerMin: token.tgGrowthPerMin,
      tgSamples: token.tgSamples.slice(-50),
    },
    smartMoney: {
      ...smart,
      hits: token.smartHits.slice(-100),
    },
    ai: {
      note: token.aiNote,
      conviction: token.aiConviction,
      analyst: token.ai,
    },
    modelDecision: token.modelDecision,
    laddersFired: token.laddersFired,
  };
}

function snapshotPayload(token: TokenRecord, entryPrice: number, now: number) {
  const price = finite(token.priceUsd);
  const multiple = price !== null && entryPrice > 0 ? price / entryPrice : null;
  const burst = burstFeatures(token, now);
  const rank = rankToken(token);
  const smart = weightedSmartHits(token.smartHits, cfg().wallets.hit_recency_hours * 3600_000, now);
  const coverage = coverageSnapshot(token, now);
  return {
    price,
    multiple,
    burst,
    rank,
    smart,
    coverage,
    raw: {
      observedAt: now,
      identity: {
        source: token.source,
        dex: token.dex,
        dexId: token.dexId,
        pairAddress: token.pairAddress,
        creator: token.creator,
        playType: token.playType,
      },
      timing: {
        firstSeen: token.firstSeen,
        convictionAt: token.convictionAt,
        triggeredAt: token.triggeredAt,
        stateChangedAt: token.stateChangedAt,
        gradAt: token.gradAt,
        fillMinutes: token.fillMinutes,
      },
      market: {
        priceUsd: token.priceUsd,
        liquidityUsd: token.liquidityUsd,
        mcapUsd: token.mcapUsd,
        vol5m: token.vol5m,
        priceChange5m: token.priceChange5m,
      },
      flow: {
        buys5m: token.buys5m,
        sells5m: token.sells5m,
        totalBuys: token.totalBuys,
        totalSells: token.totalSells,
        uniqueBuyers: token.uniqueBuyers.length,
        exactEvents5m: observedTradeEvents(token, now),
      },
      curve: {
        curveSol: token.curveSol,
        peakCurveSol: token.peakCurveSol,
        gradPeak: token.gradPeak,
        gradTrough: token.gradTrough,
      },
      safety: {
        gated: token.gated,
        gateFailReason: token.gateFailReason,
        insiderKilled: token.insiderKilled,
        devBuyPct: token.devBuyPct,
        deployerRep: token.deployerRep,
      },
      ai: { note: token.aiNote, conviction: token.aiConviction, analyst: token.ai },
    },
  };
}

export async function recordPaperOpened(
  paperTradeId: number,
  token: TokenRecord,
  signal: string,
  markPrice: number,
  context: PaperTelemetryContext = {},
  at = Date.now(),
): Promise<void> {
  if (!pool) return;
  const rank = rankToken(token);
  const burst = burstFeatures(token, at);
  const coverage = coverageSnapshot(token, at);
  const tokenSnapshot = fullTokenSnapshot(token, at);
  const exactAtEntry = observedTradeEvents(token, at);
  const entryContext = {
    capturedAt: at,
    signal,
    markPrice,
    lifecycle: context.lifecycle || null,
    conviction: context.conviction || null,
    triggerAssessment: context.triggerAssessment || null,
    token: tokenSnapshot,
  };
  await pool.query(
    `UPDATE paper_trades SET
       entry_context=$2,config_snapshot=$3,stream_snapshot=$4,rank_snapshot=$5,
       feature_snapshot=$6,burst_snapshot=$7,token_snapshot=$8,conviction_snapshot=$9,
       trigger_snapshot=$10,coverage_snapshot=$11,trough_price=COALESCE(trough_price,$12),
       trough_at=COALESCE(trough_at,entry_at),max_runup_pct=COALESCE(max_runup_pct,0),
       max_drawdown_pct=COALESCE(max_drawdown_pct,0),exact_trade_events_at_entry=$13
     WHERE id=$1`,
    [
      paperTradeId,
      JSON.stringify(entryContext),
      JSON.stringify(cfg()),
      JSON.stringify(pumpfunStreamDiag()),
      JSON.stringify(rank),
      token.modelDecision?.features ? JSON.stringify(token.modelDecision.features) : null,
      JSON.stringify(burst),
      JSON.stringify(tokenSnapshot),
      context.conviction ? JSON.stringify(context.conviction) : null,
      context.triggerAssessment ? JSON.stringify(context.triggerAssessment) : null,
      JSON.stringify(coverage),
      markPrice,
      exactAtEntry,
    ],
  ).catch(error => console.error('[telemetry] entry context', error.message));

  await recordPaperEvent(paperTradeId, token, signal, token.modelDecision?.modelVersion || 'unknown',
    'opened', 'opened', markPrice, 'paper observation opened', entryContext, at);
  await recordPaperSnapshot({
    id: paperTradeId,
    ca: token.ca,
    signal,
    model_version: token.modelDecision?.modelVersion || 'unknown',
    entry_price: markPrice,
    entry_at: new Date(at),
    peak_price: markPrice,
    trough_price: markPrice,
  }, token, at);
}

export async function recordPaperSnapshot(row: PaperSnapshotRow, token: TokenRecord, at = Date.now()): Promise<boolean> {
  if (!pool) return false;
  const entryAt = new Date(row.entry_at).getTime();
  const ageSeconds = Math.max(0, Math.floor((at - entryAt) / 1000));
  const cadence = telemetryCadenceSeconds(ageSeconds);
  const bucket = telemetryBucketSeconds(ageSeconds);
  const entryPrice = Number(row.entry_price);
  if (!(entryPrice > 0)) return false;
  const payload = snapshotPayload(token, entryPrice, at);
  const previousPeak = Number(row.peak_price) > 0 ? Number(row.peak_price) : entryPrice;
  const previousTrough = Number(row.trough_price) > 0 ? Number(row.trough_price) : entryPrice;
  const peak = payload.price === null ? previousPeak : Math.max(previousPeak, payload.price);
  const trough = payload.price === null ? previousTrough : Math.min(previousTrough, payload.price);
  const peakMultiple = peak / entryPrice;
  const troughMultiple = trough / entryPrice;
  const runupPct = (peakMultiple - 1) * 100;
  const drawdownPct = (troughMultiple - 1) * 100;
  const exactEvents = observedTradeEvents(token, at);
  const inserted = await pool.query(
    `INSERT INTO paper_trade_snapshots
       (paper_trade_id,ca,signal,model_version,captured_at,captured_age_seconds,bucket_seconds,cadence_seconds,
        phase,price_usd,multiple,peak_multiple,trough_multiple,runup_pct,drawdown_pct,liquidity_usd,mcap_usd,
        liquidity_mcap_ratio,vol_5m,buys_5m,sells_5m,buy_sell_ratio,total_buys,total_sells,unique_buyers,
        curve_sol,peak_curve_sol,score,peak_score,state,stream_mode,exact_trade_events,feature_vector,burst_features,
        subscores,rank,social,bundle,entity_graph,smart_wallets,model_decision,coverage,raw)
     VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
             $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43)
     ON CONFLICT (paper_trade_id,bucket_seconds) DO NOTHING RETURNING id`,
    [
      row.id, row.ca, row.signal, row.model_version, at, ageSeconds, bucket, cadence, telemetryPhase(ageSeconds),
      payload.price, payload.multiple, peakMultiple, troughMultiple, runupPct, drawdownPct,
      finite(token.liquidityUsd), finite(token.mcapUsd), token.mcapUsd > 0 ? token.liquidityUsd / token.mcapUsd : null,
      finite(token.vol5m), token.buys5m, token.sells5m, ratio(token.buys5m, token.sells5m), token.totalBuys,
      token.totalSells, token.uniqueBuyers.length, finite(token.curveSol), finite(token.peakCurveSol), finite(token.score),
      finite(token.peakScore), token.state, getStreamMode(), exactEvents,
      token.modelDecision?.features ? JSON.stringify(token.modelDecision.features) : null,
      JSON.stringify(payload.burst), JSON.stringify(token.subs), JSON.stringify(payload.rank), JSON.stringify(token.socials),
      token.bundle ? JSON.stringify(token.bundle) : null, token.entityGraph ? JSON.stringify(token.entityGraph) : null,
      JSON.stringify({ ...payload.smart, hits: token.smartHits.slice(-100) }),
      token.modelDecision ? JSON.stringify(token.modelDecision) : null,
      JSON.stringify(payload.coverage), JSON.stringify(payload.raw),
    ],
  ).catch(error => { console.error('[telemetry] snapshot', error.message); return null; });
  if (!inserted?.rowCount) return false;

  await pool.query(
    `UPDATE paper_trades SET snapshot_count=snapshot_count+1,
       trough_price=CASE WHEN trough_price IS NULL OR $2<trough_price THEN $2 ELSE trough_price END,
       trough_at=CASE WHEN trough_price IS NULL OR $2<trough_price THEN to_timestamp($3/1000.0) ELSE trough_at END,
       max_runup_pct=GREATEST(COALESCE(max_runup_pct,0),$4),
       max_drawdown_pct=LEAST(COALESCE(max_drawdown_pct,0),$5)
     WHERE id=$1`,
    [row.id, payload.price, at, runupPct, drawdownPct],
  ).catch(() => {});
  await recordPaperEvent(row.id, token, row.signal, row.model_version,
    'state_observed', `state:${token.state}`, payload.price, null, { state: token.state }, at);
  return true;
}

export async function recordPaperEvent(
  paperTradeId: number,
  token: TokenRecord | null,
  signal: string,
  modelVersion: string,
  eventType: string,
  dedupeKey: string,
  price: number | null,
  reason: string | null,
  payload: unknown,
  at = Date.now(),
): Promise<boolean> {
  if (!pool) return false;
  const entry = await pool.query(`SELECT entry_price FROM paper_trades WHERE id=$1`, [paperTradeId])
    .catch(() => ({ rows: [] as any[] }));
  const entryPrice = Number(entry.rows[0]?.entry_price);
  const multiple = price !== null && entryPrice > 0 ? price / entryPrice : null;
  const inserted = await pool.query(
    `INSERT INTO paper_trade_events
       (paper_trade_id,ca,signal,model_version,event_type,dedupe_key,at,price_usd,multiple,state,reason,payload)
     SELECT id,ca,signal,model_version,$2,$3,to_timestamp($4/1000.0),$5,$6,$7,$8,$9
       FROM paper_trades WHERE id=$1
     ON CONFLICT (paper_trade_id,dedupe_key) DO NOTHING RETURNING id`,
    [paperTradeId, eventType, dedupeKey, at, price, multiple, token?.state || null, reason, JSON.stringify(payload || {})],
  ).catch(error => { console.error('[telemetry] event', error.message); return null; });
  if (!inserted?.rowCount) return false;
  await pool.query(`UPDATE paper_trades SET event_count=event_count+1 WHERE id=$1`, [paperTradeId]).catch(() => {});
  return true;
}

export async function finalizePaperTelemetry(
  paperTradeId: number,
  token: TokenRecord | null,
  price: number | null,
  reason: string,
  at = Date.now(),
): Promise<void> {
  if (!pool) return;
  const row = await pool.query(
    `SELECT ca,signal,model_version,entry_price,entry_at,peak_price,trough_price FROM paper_trades WHERE id=$1`,
    [paperTradeId],
  ).catch(() => ({ rows: [] as any[] }));
  const trade = row.rows[0];
  if (!trade) return;
  const entryPrice = Number(trade.entry_price);
  const finalPrice = price && price > 0 ? price : null;
  const multiple = finalPrice !== null && entryPrice > 0 ? finalPrice / entryPrice : null;
  const durationSeconds = Math.max(0, Math.floor((at - new Date(trade.entry_at).getTime()) / 1000));
  const exact = await pool.query(
    `SELECT COUNT(*)::int AS n FROM trade_events
      WHERE ca=$1 AND at>=$2 AND at<=to_timestamp($3/1000.0)`,
    [trade.ca, trade.entry_at, at],
  ).catch(() => ({ rows: [{ n: 0 }] }));
  const exitContext = {
    capturedAt: at,
    reason,
    finalPrice,
    finalMultiple: multiple,
    pnlPct: multiple === null ? null : (multiple - 1) * 100,
    durationSeconds,
    token: token ? fullTokenSnapshot(token, at) : null,
    stream: pumpfunStreamDiag(),
    coverage: token ? coverageSnapshot(token, at) : { missingTokenAtClose: true },
  };
  await pool.query(
    `UPDATE paper_trades SET exit_context=$2,final_multiple=$3,pnl_pct=$4,duration_seconds=$5,
       exact_trade_events_during_call=$6
     WHERE id=$1`,
    [paperTradeId, JSON.stringify(exitContext), multiple, multiple === null ? null : (multiple - 1) * 100,
      durationSeconds, Number(exact.rows[0]?.n) || 0],
  ).catch(error => console.error('[telemetry] finalize', error.message));
  await recordPaperEvent(paperTradeId, token, trade.signal, trade.model_version,
    'closed', `closed:${reason}`, finalPrice, reason, exitContext, at);
}

export async function paperTelemetryDiag() {
  if (!pool) return {
    total: 0, withEntryContext: 0, missingEntryContext: 0, snapshots: 0, events: 0,
    exactTradeEvents: 0, openWithoutRecentSnapshot: 0,
  };
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE entry_context IS NOT NULL)::int AS with_entry_context,
            COUNT(*) FILTER (WHERE entry_context IS NULL)::int AS missing_entry_context,
            COALESCE(SUM(snapshot_count),0)::int AS snapshots,
            COALESCE(SUM(event_count),0)::int AS events,
            COALESCE(SUM(exact_trade_events_during_call),0)::int AS exact_trade_events,
            COUNT(*) FILTER (WHERE NOT closed AND NOT EXISTS (
              SELECT 1 FROM paper_trade_snapshots s
               WHERE s.paper_trade_id=paper_trades.id AND s.captured_at>now()-interval '6 minutes'
            ))::int AS open_without_recent_snapshot
       FROM paper_trades`,
  ).catch(() => ({ rows: [{}] }));
  const row = result.rows[0] || {};
  return {
    total: Number(row.total) || 0,
    withEntryContext: Number(row.with_entry_context) || 0,
    missingEntryContext: Number(row.missing_entry_context) || 0,
    snapshots: Number(row.snapshots) || 0,
    events: Number(row.events) || 0,
    exactTradeEvents: Number(row.exact_trade_events) || 0,
    openWithoutRecentSnapshot: Number(row.open_without_recent_snapshot) || 0,
  };
}
