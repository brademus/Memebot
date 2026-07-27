import { pool } from '../db';
import { assessTrigger } from '../scoring/states';
import { getToken } from '../store';
import { TokenRecord } from '../types';
import { finalizePaperTelemetry, recordPaperEvent } from './telemetry';
import {
  ADAPTIVE_EXIT_POLICY,
  adaptiveExitDecision,
  benchmarkExitDecision,
  STRATEGY_NOTIONAL_USD,
  STRATEGY_VERSION,
  strategyRoleForSignal,
  StrategyExitEvaluation,
  StrategyExitInput,
  StrategyRole,
} from './strategy-policy';

const EPOCH_NAME = 'strategy_lifecycle_v1';
const LOOP_MS = 5_000;
const EXIT_EVALUATION_WRITE_MS = 15_000;
const DECISION_LEDGER_BUCKET_MS = 5 * 60_000;

let schemaPromise: Promise<string> | null = null;
let running = false;
let started = false;
const diag = {
  runs: 0,
  qualityDecisions: 0,
  entryBuyDecisions: 0,
  entryWaitDecisions: 0,
  exitHoldDecisions: 0,
  exitSellDecisions: 0,
  benchmarkCloses: 0,
  adaptiveCloses: 0,
  closeBackfills: 0,
  lastRunAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
  epochAt: null as string | null,
};

export const strategyLifecycleDiag = () => ({
  enabled: !!pool,
  strategyVersion: STRATEGY_VERSION,
  epochName: EPOCH_NAME,
  intervalSeconds: LOOP_MS / 1000,
  ...diag,
});

const numberOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asObject = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
};

const walletCount = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

const currentSmartWallets = (token: TokenRecord | null): number => token
  ? new Set(token.smartHits.map(hit => hit.wallet)).size : 0;

const earlyRetention = (token: TokenRecord | null): number | null => {
  if (!token || !token.earlyBuyers.length) return null;
  return Math.max(0, 1 - token.earlyExited.length / token.earlyBuyers.length);
};

export function ensureStrategyLifecycleSchema(): Promise<string> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    if (!pool) throw new Error('DATABASE_URL unavailable');
    await pool.query(`CREATE TABLE IF NOT EXISTS evidence_epochs (
      name TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    await pool.query(`INSERT INTO evidence_epochs (name,metadata)
      VALUES ($1,$2::jsonb) ON CONFLICT (name) DO NOTHING`, [EPOCH_NAME, JSON.stringify({
      purpose: 'separate coin-quality selection, timed entry, and explainable adaptive exits',
      strategyVersion: STRATEGY_VERSION,
      qualityObservationsArePositions: false,
      timedEntryNotionalUsd: STRATEGY_NOTIONAL_USD,
    })]);
    await pool.query(`ALTER TABLE paper_trades
      ADD COLUMN IF NOT EXISTS strategy_role TEXT NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS strategy_version TEXT NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS parent_observation_id BIGINT,
      ADD COLUMN IF NOT EXISTS quality_decision JSONB,
      ADD COLUMN IF NOT EXISTS entry_decision JSONB,
      ADD COLUMN IF NOT EXISTS exit_decision JSONB,
      ADD COLUMN IF NOT EXISTS last_exit_evaluation JSONB,
      ADD COLUMN IF NOT EXISTS last_exit_evaluated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS exit_policy_version TEXT,
      ADD COLUMN IF NOT EXISTS notional_usd NUMERIC NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS realized_pnl_usd NUMERIC`);
    await pool.query(`CREATE TABLE IF NOT EXISTS strategy_decisions (
      id BIGSERIAL PRIMARY KEY,
      paper_trade_id BIGINT NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
      ca TEXT NOT NULL,
      symbol TEXT,
      model_version TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      stage TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reasons TEXT[] NOT NULL DEFAULT '{}',
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      price_usd NUMERIC,
      score NUMERIC,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key TEXT NOT NULL,
      UNIQUE (paper_trade_id,stage,dedupe_key)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_strategy_decisions_stage_at
      ON strategy_decisions(stage,at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_strategy_decisions_trade_at
      ON strategy_decisions(paper_trade_id,at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_paper_strategy_role_entry
      ON paper_trades(strategy_role,entry_at DESC)`);
    const epoch = await pool.query(`SELECT started_at FROM evidence_epochs WHERE name=$1`, [EPOCH_NAME]);
    const epochAt = new Date(epoch.rows[0]?.started_at || Date.now()).toISOString();
    diag.epochAt = epochAt;
    return epochAt;
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function stampStrategyRows(epochAt: string) {
  if (!pool) return;
  await pool.query(`UPDATE paper_trades SET
      strategy_role=CASE
        WHEN signal='trigger' THEN 'timed_entry'
        WHEN signal LIKE 'bb_%' OR signal='conviction' THEN 'quality_observation'
        WHEN signal LIKE 'model%' THEN 'model_observation'
        ELSE strategy_role END,
      strategy_version=$2,
      notional_usd=CASE WHEN signal='trigger' THEN $3 ELSE 0 END
    WHERE entry_at>=$1::timestamptz AND strategy_version IS DISTINCT FROM $2`,
  [epochAt, STRATEGY_VERSION, STRATEGY_NOTIONAL_USD]);
}

async function recordDecision(input: {
  paperTradeId: number;
  ca: string;
  symbol: string | null;
  modelVersion: string;
  stage: 'quality' | 'entry' | 'exit';
  decision: string;
  reasonCode: string;
  reasons: string[];
  at?: number;
  price: number | null;
  score: number | null;
  metrics?: unknown;
  evidence?: unknown;
  dedupeKey: string;
}): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(`INSERT INTO strategy_decisions
      (paper_trade_id,ca,symbol,model_version,strategy_version,stage,decision,reason_code,reasons,
       at,price_usd,score,metrics,evidence,dedupe_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],to_timestamp($10/1000.0),$11,$12,$13::jsonb,$14::jsonb,$15)
    ON CONFLICT (paper_trade_id,stage,dedupe_key) DO NOTHING RETURNING id`, [
    input.paperTradeId, input.ca, input.symbol, input.modelVersion, STRATEGY_VERSION,
    input.stage, input.decision, input.reasonCode, input.reasons, input.at || Date.now(), input.price,
    input.score, JSON.stringify(input.metrics || {}), JSON.stringify(input.evidence || {}), input.dedupeKey,
  ]).catch(() => ({ rowCount: 0 } as any));
  return Number(result.rowCount || 0) > 0;
}

function qualityDecision(row: any) {
  const token = asObject(row.token_snapshot);
  const rank = asObject(row.rank_snapshot);
  const conviction = asObject(row.conviction_snapshot);
  const market = asObject(token.market);
  const flow = asObject(token.flow);
  const safety = asObject(token.safety);
  const social = asObject(token.social);
  const smart = asObject(token.smartMoney);
  const bundle = asObject(safety.bundle);
  const score = numberOrNull(row.entry_score);
  const buys = Number(flow.buys5m || 0);
  const sells = Number(flow.sells5m || 0);
  const buySellRatio = sells > 0 ? buys / sells : buys > 0 ? 3 : 1;
  const confirmations: string[] = [];
  if (social.x || social.tg || social.web) confirmations.push('credible social presence');
  if (Object.keys(bundle).length && Number(bundle.fundedSnipers || 0) === 0)
    confirmations.push('bundle check found no funded deployer-linked snipers');
  if (walletCount(smart.wallets) > 0 || walletCount(smart.weight) > 0)
    confirmations.push(`${Math.max(walletCount(smart.wallets), walletCount(smart.weight))} weighted smart-wallet confirmation(s)`);
  if (!confirmations.length) confirmations.push('independent confirmation was present in the recorded conviction gate');

  const lane = conviction.lane || String(row.signal || '').replace(/^bb_/, '') || 'unknown';
  const reasons = [
    'The coin passed the hard safety and launch-quality gates before selection.',
    `It qualified for the ${lane} quality lane.`,
    `Recorded score ${score === null ? 'unknown' : score.toFixed(1)} and grade ${rank.grade || 'unknown'} with ${rank.timing || 'unknown'} timing.`,
    `Entry-observation flow showed ${buys} buys, ${sells} sells, and a ${buySellRatio.toFixed(2)} buy/sell ratio.`,
    ...confirmations.map(value => `Independent confirmation: ${value}.`),
  ];
  return {
    stage: 'quality',
    decision: 'candidate_selected',
    worthFurtherEntryStudy: true,
    lane,
    reasons,
    metrics: {
      score, grade: rank.grade || null, timing: rank.timing || null,
      priceUsd: numberOrNull(row.entry_price), liquidityUsd: numberOrNull(market.liquidityUsd),
      mcapUsd: numberOrNull(market.mcapUsd), buys5m: buys, sells5m: sells, buySellRatio,
      uniqueBuyers: Number(flow.uniqueBuyers || 0), devBuyPct: numberOrNull(safety.devBuyPct),
      fundedSnipers: numberOrNull(bundle.fundedSnipers), smartWallets: walletCount(smart.wallets),
    },
    evidence: { rank, conviction, confirmations, safety, market, flow },
    policyVersion: STRATEGY_VERSION,
  };
}

async function recordMissingQualityDecisions(epochAt: string) {
  if (!pool) return;
  const result = await pool.query(`SELECT id,ca,symbol,signal,model_version,entry_at,entry_price,entry_score,
      token_snapshot,rank_snapshot,conviction_snapshot
    FROM paper_trades
    WHERE entry_at>=$1::timestamptz AND strategy_role='quality_observation' AND quality_decision IS NULL
    ORDER BY entry_at LIMIT 100`, [epochAt]);
  for (const row of result.rows) {
    const decision = qualityDecision(row);
    const updated = await pool.query(`UPDATE paper_trades SET quality_decision=$2::jsonb
      WHERE id=$1 AND quality_decision IS NULL RETURNING id`, [row.id, JSON.stringify(decision)]);
    if (!updated.rowCount) continue;
    const inserted = await recordDecision({
      paperTradeId: Number(row.id), ca: row.ca, symbol: row.symbol, modelVersion: row.model_version,
      stage: 'quality', decision: 'candidate_selected', reasonCode: `quality_${decision.lane}_selected`,
      reasons: decision.reasons, price: numberOrNull(row.entry_price), score: numberOrNull(row.entry_score),
      metrics: decision.metrics, evidence: decision.evidence, dedupeKey: 'quality:selected',
    });
    if (inserted) diag.qualityDecisions++;
    const token = getToken(row.ca);
    await recordPaperEvent(Number(row.id), token || null, row.signal, row.model_version,
      'quality_candidate_selected', 'strategy:quality:selected', numberOrNull(row.entry_price),
      decision.reasons.join(' '), decision, new Date(row.entry_at).getTime());
  }
}

function entryDecision(row: any) {
  const trigger = asObject(row.trigger_snapshot);
  const lifecycle = asObject(row.entry_lifecycle);
  const entryPrice = Number(row.entry_price);
  const qualityPrice = numberOrNull(row.quality_price);
  const seconds = row.quality_at ? Math.max(0,
    Math.round((new Date(row.entry_at).getTime() - new Date(row.quality_at).getTime()) / 1000)) : null;
  const premiumPct = qualityPrice && qualityPrice > 0 ? (entryPrice / qualityPrice - 1) * 100 : null;
  const reasons = [
    row.parent_id ? `The coin first passed quality selection in paper observation ${row.parent_id}.` : 'The trigger was recorded without a linked quality observation.',
    trigger.conviction?.holdReady === true || trigger.conviction?.queued === true
      ? 'The conviction observation period completed.' : 'The recorded trigger state completed its conviction requirement.',
    trigger.evidenceReady === true ? 'Minimum trade and buyer evidence was present.' : 'The state machine marked the evidence gate ready.',
    trigger.persistenceReady === true ? 'Buyer-flow persistence was confirmed.' : 'The state machine accepted persistence at the trigger.',
    trigger.burstCooled === true ? 'The short-term burst cooled enough to avoid chasing the initial spike.' : 'The trigger passed the configured anti-chase ceiling.',
    trigger.tooLate === false ? 'Price had not exceeded the late-entry ceiling.' : 'The trigger was accepted by the persisted state transition.',
    `Buy/sell ratio at the timed entry was ${Number(trigger.buyRatio || 0).toFixed(2)}.`,
    `The timed entry occurred ${seconds === null ? 'an unknown number of' : seconds} seconds after quality selection${premiumPct === null ? '' : ` at a ${premiumPct.toFixed(1)}% price change from the quality observation`}.`,
  ];
  return {
    stage: 'entry', decision: 'buy', reasons,
    qualityObservationId: row.parent_id ? Number(row.parent_id) : null,
    timing: {
      qualityObservedAt: row.quality_at || null, boughtAt: row.entry_at,
      secondsQualityToEntry: seconds, qualityPrice, entryPrice, entryPremiumPct: premiumPct,
      lifecycle,
    },
    assessment: trigger,
    policyVersion: STRATEGY_VERSION,
  };
}

async function recordMissingEntryBuyDecisions(epochAt: string) {
  if (!pool) return;
  const result = await pool.query(`SELECT p.id,p.ca,p.symbol,p.signal,p.model_version,p.entry_at,p.entry_price,p.entry_score,
      p.trigger_snapshot,p.entry_context#>'{lifecycle}' AS entry_lifecycle,
      q.id AS parent_id,q.entry_at AS quality_at,q.entry_price AS quality_price
    FROM paper_trades p
    LEFT JOIN LATERAL (
      SELECT id,entry_at,entry_price FROM paper_trades q
      WHERE q.ca=p.ca AND q.model_version=p.model_version AND q.strategy_role='quality_observation'
        AND q.entry_at<=p.entry_at
      ORDER BY q.entry_at DESC LIMIT 1
    ) q ON true
    WHERE p.entry_at>=$1::timestamptz AND p.strategy_role='timed_entry' AND p.entry_decision IS NULL
    ORDER BY p.entry_at LIMIT 100`, [epochAt]);
  for (const row of result.rows) {
    const decision = entryDecision(row);
    const updated = await pool.query(`UPDATE paper_trades SET parent_observation_id=$2,entry_decision=$3::jsonb,
        notional_usd=$4
      WHERE id=$1 AND entry_decision IS NULL RETURNING id`,
    [row.id, row.parent_id || null, JSON.stringify(decision), STRATEGY_NOTIONAL_USD]);
    if (!updated.rowCount) continue;
    const inserted = await recordDecision({
      paperTradeId: Number(row.id), ca: row.ca, symbol: row.symbol, modelVersion: row.model_version,
      stage: 'entry', decision: 'buy', reasonCode: 'timing_gate_buy', reasons: decision.reasons,
      at: new Date(row.entry_at).getTime(), price: numberOrNull(row.entry_price), score: numberOrNull(row.entry_score),
      metrics: decision.timing, evidence: decision.assessment, dedupeKey: 'entry:buy',
    });
    if (inserted) diag.entryBuyDecisions++;
    const token = getToken(row.ca);
    await recordPaperEvent(Number(row.id), token || null, row.signal, row.model_version,
      'timed_entry_bought', 'strategy:entry:buy', numberOrNull(row.entry_price),
      decision.reasons.join(' '), decision, new Date(row.entry_at).getTime());
  }
}

async function recordEntryWaitDecisions(epochAt: string) {
  if (!pool) return;
  const rows = await pool.query(`SELECT q.id,q.ca,q.symbol,q.signal,q.model_version,q.entry_price,q.entry_score
    FROM paper_trades q
    WHERE q.entry_at>=$1::timestamptz AND q.strategy_role='quality_observation'
      AND NOT EXISTS (SELECT 1 FROM paper_trades p
        WHERE p.ca=q.ca AND p.model_version=q.model_version AND p.strategy_role='timed_entry')
    ORDER BY q.entry_at DESC LIMIT 100`, [epochAt]);
  const now = Date.now();
  const bucket = Math.floor(now / DECISION_LEDGER_BUCKET_MS);
  for (const row of rows.rows) {
    const token = getToken(row.ca);
    if (!token) {
      const inserted = await recordDecision({
        paperTradeId: Number(row.id), ca: row.ca, symbol: row.symbol, modelVersion: row.model_version,
        stage: 'entry', decision: 'skip', reasonCode: 'entry_skipped_token_left_live_store',
        reasons: ['The quality candidate left the live token store before a timed buy trigger was confirmed.'],
        price: numberOrNull(row.entry_price), score: numberOrNull(row.entry_score), dedupeKey: 'entry:skip:missing',
      });
      if (inserted) diag.entryWaitDecisions++;
      continue;
    }
    const assessment = assessTrigger(token, now);
    const terminal = ['DYING', 'DEAD', 'EXTENDED'].includes(token.state);
    const decision = terminal ? 'skip' : assessment.ready ? 'ready' : 'wait';
    const reasons = terminal
      ? [`The quality candidate moved to ${token.state} before entry.`]
      : assessment.ready ? ['Every recorded entry-timing condition is ready; the state transition is pending.']
        : assessment.blockers.length ? assessment.blockers : ['Entry timing is still collecting evidence.'];
    const inserted = await recordDecision({
      paperTradeId: Number(row.id), ca: row.ca, symbol: row.symbol, modelVersion: row.model_version,
      stage: 'entry', decision, reasonCode: terminal ? `entry_skipped_${token.state.toLowerCase()}`
        : assessment.ready ? 'entry_ready' : 'entry_waiting',
      reasons, price: token.priceUsd > 0 ? token.priceUsd : null, score: token.score,
      metrics: {
        buyRatio: assessment.buyRatio, movedPct: assessment.movedPct,
        evidenceReady: assessment.evidenceReady, persistenceReady: assessment.persistenceReady,
        burstCooled: assessment.burstCooled, tooLate: assessment.tooLate,
        sourceEligible: assessment.sourceEligible, modelAllows: assessment.modelAllows,
        state: token.state,
      },
      evidence: assessment, dedupeKey: terminal ? `entry:skip:${token.state}` : `entry:${decision}:${bucket}`,
    });
    if (inserted) diag.entryWaitDecisions++;
  }
}

function exitInput(row: any, token: TokenRecord | null): StrategyExitInput | null {
  const entryPrice = Number(row.entry_price);
  const markPrice = token && token.priceUsd > 0 ? token.priceUsd : Number(row.last_price);
  if (!(entryPrice > 0) || !(markPrice > 0)) return null;
  const entryToken = asObject(row.token_snapshot);
  const entryMarket = asObject(entryToken.market);
  const entrySmart = asObject(entryToken.smartMoney);
  const model = token?.modelDecision;
  return {
    role: strategyRoleForSignal(row.signal),
    entryPrice,
    markPrice,
    peakPrice: Math.max(markPrice, Number(row.peak_price) || markPrice),
    ageHours: Math.max(0, (Date.now() - new Date(row.entry_at).getTime()) / 3_600_000),
    entryScore: numberOrNull(row.entry_score),
    currentScore: token ? token.score : numberOrNull(row.entry_score),
    entryLiquidityUsd: numberOrNull(entryMarket.liquidityUsd),
    currentLiquidityUsd: token ? numberOrNull(token.liquidityUsd) : null,
    buys5m: token?.buys5m || 0,
    sells5m: token?.sells5m || 0,
    priceChange5m: token ? numberOrNull(token.priceChange5m) : null,
    entrySmartWallets: Math.max(walletCount(entrySmart.wallets), walletCount(entrySmart.weight)),
    currentSmartWallets: currentSmartWallets(token),
    earlyRetention: earlyRetention(token),
    modelExpectedValue: model ? numberOrNull(model.expectedValue) : null,
    modelDownsideProbability: model ? numberOrNull(model.downsideProbability) : null,
    state: token?.state || null,
    insiderKilled: token?.insiderKilled || false,
    fundedSnipers: Number(token?.bundle?.fundedSnipers || 0),
  };
}

async function closeFromEvaluation(row: any, token: TokenRecord | null, evaluation: StrategyExitEvaluation) {
  if (!pool || evaluation.action !== 'sell' || !evaluation.exitPrice) return;
  const role = strategyRoleForSignal(row.signal);
  const realizedPnlUsd = role === 'timed_entry'
    ? Number(((evaluation.multiple - 1) * STRATEGY_NOTIONAL_USD).toFixed(2)) : null;
  const decision = {
    stage: 'exit', decision: 'sell', role, reasonCode: evaluation.reasonCode,
    reasons: evaluation.reasons, deteriorationSignals: evaluation.deteriorationSignals,
    metrics: evaluation.metrics, activeStopMultiple: evaluation.activeStopMultiple,
    exitPrice: evaluation.exitPrice, exitMultiple: evaluation.multiple,
    notionalUsd: role === 'timed_entry' ? STRATEGY_NOTIONAL_USD : 0,
    realizedPnlUsd, policyVersion: STRATEGY_VERSION,
    decidedAt: Date.now(),
  };
  const closed = await pool.query(`UPDATE paper_trades SET
      closed=true,exit_at=now(),exit_reason=$2,exit_price=$3,last_price=$3,last_at=now(),
      exit_decision=$4::jsonb,exit_policy_version=$5,
      notional_usd=CASE WHEN strategy_role='timed_entry' THEN $6 ELSE 0 END,
      realized_pnl_usd=$7,
      target_hit_at=CASE WHEN $2='strategy_take_profit_3x' OR $2='benchmark_take_profit_3x'
        THEN COALESCE(target_hit_at,now()) ELSE target_hit_at END,
      observed_target_hit_at=CASE WHEN $2='strategy_take_profit_3x' OR $2='benchmark_take_profit_3x'
        THEN COALESCE(observed_target_hit_at,now()) ELSE observed_target_hit_at END,
      seconds_to_target=CASE WHEN $2='strategy_take_profit_3x' OR $2='benchmark_take_profit_3x'
        THEN COALESCE(seconds_to_target,EXTRACT(EPOCH FROM (now()-entry_at))::int) ELSE seconds_to_target END
    WHERE id=$1 AND closed=false RETURNING id`, [
    row.id, evaluation.reasonCode, evaluation.exitPrice, JSON.stringify(decision), STRATEGY_VERSION,
    STRATEGY_NOTIONAL_USD, realizedPnlUsd,
  ]).catch(() => null);
  if (!closed?.rowCount) return;
  await finalizePaperTelemetry(Number(row.id), token || null, evaluation.exitPrice, evaluation.reasonCode);
  await recordPaperEvent(Number(row.id), token || null, row.signal, row.model_version,
    'strategy_exit_sold', `strategy:exit:${evaluation.reasonCode}`, evaluation.exitPrice,
    evaluation.reasons.join(' '), decision);
  const inserted = await recordDecision({
    paperTradeId: Number(row.id), ca: row.ca, symbol: row.symbol, modelVersion: row.model_version,
    stage: 'exit', decision: 'sell', reasonCode: evaluation.reasonCode, reasons: evaluation.reasons,
    price: evaluation.exitPrice, score: token ? token.score : numberOrNull(row.entry_score),
    metrics: evaluation.metrics, evidence: decision, dedupeKey: `exit:sell:${evaluation.reasonCode}`,
  });
  if (inserted) diag.exitSellDecisions++;
  if (role === 'timed_entry') diag.adaptiveCloses++; else diag.benchmarkCloses++;
  console.log(`[strategy] ${role} $${row.symbol || row.ca.slice(0, 6)} closed: ${evaluation.reasonCode} at ${evaluation.multiple.toFixed(2)}x`);
}

async function evaluateOpenPositions(epochAt: string) {
  if (!pool) return;
  const result = await pool.query(`SELECT id,ca,symbol,signal,model_version,entry_at,entry_price,entry_score,
      last_price,peak_price,token_snapshot,last_exit_evaluated_at
    FROM paper_trades
    WHERE entry_at>=$1::timestamptz AND strategy_version=$2 AND closed=false
    ORDER BY entry_at LIMIT 500`, [epochAt, STRATEGY_VERSION]);
  const now = Date.now();
  const decisionBucket = Math.floor(now / DECISION_LEDGER_BUCKET_MS);
  for (const row of result.rows) {
    const token = getToken(row.ca);
    const input = exitInput(row, token || null);
    if (!input) continue;
    const role = strategyRoleForSignal(row.signal);
    const evaluation = role === 'timed_entry'
      ? adaptiveExitDecision(input)
      : benchmarkExitDecision(input.entryPrice, input.markPrice, input.peakPrice, input.ageHours);
    const evaluationRecord = {
      ...evaluation,
      role,
      policyVersion: STRATEGY_VERSION,
      evaluatedAt: now,
      source: token ? 'live_token' : 'last_persisted_mark',
    };
    const lastWritten = row.last_exit_evaluated_at ? new Date(row.last_exit_evaluated_at).getTime() : 0;
    if (now - lastWritten >= EXIT_EVALUATION_WRITE_MS) {
      await pool.query(`UPDATE paper_trades SET last_exit_evaluation=$2::jsonb,last_exit_evaluated_at=now()
        WHERE id=$1 AND closed=false`, [row.id, JSON.stringify(evaluationRecord)]).catch(() => {});
    }
    if (evaluation.action === 'sell') {
      await closeFromEvaluation(row, token || null, evaluation);
      continue;
    }
    if (role === 'timed_entry') {
      const inserted = await recordDecision({
        paperTradeId: Number(row.id), ca: row.ca, symbol: row.symbol, modelVersion: row.model_version,
        stage: 'exit', decision: 'hold', reasonCode: evaluation.reasonCode, reasons: evaluation.reasons,
        price: input.markPrice, score: token ? token.score : numberOrNull(row.entry_score),
        metrics: evaluation.metrics, evidence: evaluationRecord, dedupeKey: `exit:hold:${decisionBucket}`,
      });
      if (inserted) diag.exitHoldDecisions++;
    }
  }
}

async function backfillExternallyClosedDecisions(epochAt: string) {
  if (!pool) return;
  const result = await pool.query(`SELECT id,ca,symbol,signal,model_version,entry_price,entry_score,
      exit_at,exit_price,exit_reason,final_multiple,exit_context,strategy_role
    FROM paper_trades
    WHERE entry_at>=$1::timestamptz AND strategy_version=$2 AND closed=true AND exit_decision IS NULL
    ORDER BY exit_at LIMIT 100`, [epochAt, STRATEGY_VERSION]);
  for (const row of result.rows) {
    const entry = Number(row.entry_price);
    const exit = Number(row.exit_price);
    const multiple = numberOrNull(row.final_multiple) || (entry > 0 && exit > 0 ? exit / entry : null);
    const role = strategyRoleForSignal(row.signal);
    const realizedPnlUsd = role === 'timed_entry' && multiple !== null
      ? Number(((multiple - 1) * STRATEGY_NOTIONAL_USD).toFixed(2)) : null;
    const reasons = [`Another paper lifecycle component closed the record with reason ${row.exit_reason || 'unknown'}.`,
      'The strategy ledger preserved that close instead of rewriting historical evidence.'];
    const decision = {
      stage: 'exit', decision: 'sell', role,
      reasonCode: row.exit_reason || 'external_close', reasons,
      exitPrice: numberOrNull(row.exit_price), exitMultiple: multiple,
      notionalUsd: role === 'timed_entry' ? STRATEGY_NOTIONAL_USD : 0,
      realizedPnlUsd, policyVersion: STRATEGY_VERSION,
      externalClose: true, exitContext: row.exit_context || null,
    };
    const updated = await pool.query(`UPDATE paper_trades SET exit_decision=$2::jsonb,
        exit_policy_version=COALESCE(exit_policy_version,$3),realized_pnl_usd=$4
      WHERE id=$1 AND exit_decision IS NULL RETURNING id`,
    [row.id, JSON.stringify(decision), STRATEGY_VERSION, realizedPnlUsd]);
    if (!updated.rowCount) continue;
    const inserted = await recordDecision({
      paperTradeId: Number(row.id), ca: row.ca, symbol: row.symbol, modelVersion: row.model_version,
      stage: 'exit', decision: 'sell', reasonCode: row.exit_reason || 'external_close', reasons,
      at: row.exit_at ? new Date(row.exit_at).getTime() : Date.now(), price: numberOrNull(row.exit_price),
      score: numberOrNull(row.entry_score), metrics: { multiple, realizedPnlUsd }, evidence: decision,
      dedupeKey: `exit:external:${row.exit_reason || 'unknown'}`,
    });
    if (inserted) {
      diag.exitSellDecisions++;
      diag.closeBackfills++;
    }
  }
}

async function runStrategyLifecycle() {
  if (!pool || running) return;
  running = true;
  diag.runs++;
  diag.lastRunAt = new Date().toISOString();
  try {
    const epochAt = await ensureStrategyLifecycleSchema();
    await stampStrategyRows(epochAt);
    await recordMissingQualityDecisions(epochAt);
    await recordMissingEntryBuyDecisions(epochAt);
    await recordEntryWaitDecisions(epochAt);
    await evaluateOpenPositions(epochAt);
    await backfillExternallyClosedDecisions(epochAt);
    diag.lastSuccessAt = new Date().toISOString();
    diag.lastError = null;
  } catch (error) {
    diag.lastError = (error as Error).message.slice(0, 400);
    console.error('[strategy-lifecycle]', diag.lastError);
  } finally {
    running = false;
  }
}

export function startStrategyLifecycle() {
  if (!pool || started) return;
  started = true;
  void runStrategyLifecycle();
  const timer = setInterval(() => void runStrategyLifecycle(), LOOP_MS);
  timer.unref();
  console.log(`[strategy-lifecycle] ${STRATEGY_VERSION} enabled: quality observations are research-only; timed trigger entries use explainable adaptive exits`);
}

export { ADAPTIVE_EXIT_POLICY };
