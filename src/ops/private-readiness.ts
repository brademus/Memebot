import { telegramDiag } from '../alerts/telegram';
import { cfg, env } from '../config';
import { heliusHealth } from '../helius';
import { pumpfunStreamDiag } from '../ingest/pumpfun';
import { allTokens } from '../store';

export interface PaperReadinessInput {
  db: boolean;
  transactionBuilt: number;
  simulationOk: number;
  executable: number;
  recentClosed: number;
  recentTrackingLost: number;
  recentTrackingLostPct: number | null;
  executionEpochAt: string | null;
}

interface ReadinessCheck {
  id: string;
  label: string;
  weight: number;
  earned: number;
  status: 'pass' | 'collecting' | 'warn' | 'fail';
  detail: string;
  blocker: boolean;
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FRESH_TRADE_MS = 4 * 60_000;
const FRESH_MARKET_MS = 5 * 60_000;

const round1 = (value: number) => Math.round(value * 10) / 10;
const iso = (value: number | null) => value ? new Date(value).toISOString() : null;

function streamCoverage(now = Date.now()) {
  const eligible = allTokens().filter(token => token.gated === true
    && token.dex === 'pumpfun'
    && !['DEAD', 'DYING'].includes(token.state));
  const active = eligible.filter(token => {
    const lastTrade = token.recentTrades[token.recentTrades.length - 1]?.at || 0;
    const marketAt = Number((token as any).marketUpdatedAt || 0);
    return now - Math.max(lastTrade, marketAt, token.firstSeen) <= FRESH_MARKET_MS;
  });
  const fresh = active.filter(token => {
    const lastTrade = token.recentTrades[token.recentTrades.length - 1]?.at || 0;
    return lastTrade > 0 && now - lastTrade <= FRESH_TRADE_MS;
  });
  const stale = active.filter(token => {
    const lastTrade = token.recentTrades[token.recentTrades.length - 1]?.at || 0;
    return !lastTrade || now - lastTrade > FRESH_TRADE_MS;
  });
  return {
    eligible: eligible.length,
    active: active.length,
    fresh: fresh.length,
    stale: stale.length,
    coveragePct: active.length ? round1(fresh.length / active.length * 100) : null,
    staleSample: stale.slice(0, 12).map(token => ({
      ca: token.ca,
      symbol: token.symbol,
      ageMin: Math.round((now - token.firstSeen) / 60_000),
      lastTradeAt: iso(token.recentTrades[token.recentTrades.length - 1]?.at || null),
    })),
  };
}

function addCheck(
  checks: ReadinessCheck[],
  id: string,
  label: string,
  weight: number,
  earned: number,
  status: ReadinessCheck['status'],
  detail: string,
  blocker = false,
) {
  checks.push({ id, label, weight, earned: Math.max(0, Math.min(weight, earned)), status, detail, blocker });
}

export function buildPrivateReadiness(paper: PaperReadinessInput) {
  const pump = pumpfunStreamDiag();
  const helius = heliusHealth();
  const telegram = telegramDiag();
  const coverage = streamCoverage();
  const checks: ReadinessCheck[] = [];
  const warmup = process.uptime() < 120;

  addCheck(checks, 'database', 'PostgreSQL persistence', 1, paper.db ? 1 : 0,
    paper.db ? 'pass' : 'fail', paper.db ? 'database attached' : 'DATABASE_URL is missing or unavailable', !paper.db);

  const pumpHealthy = pump.connected && pump.effectiveMode === 'full' && pump.reason === 'healthy';
  addCheck(checks, 'pumpportal', 'PumpPortal paid trade stream', 1.5, pumpHealthy ? 1.5 : warmup ? 0.5 : 0,
    pumpHealthy ? 'pass' : warmup ? 'collecting' : 'fail',
    pumpHealthy ? `healthy; ${pump.messages.tradesReceived} paid trades received this boot`
      : `mode=${pump.effectiveMode}; reason=${pump.reason}`, !pumpHealthy && !warmup);

  let coverageEarned = 0.75;
  let coverageStatus: ReadinessCheck['status'] = 'collecting';
  let coverageBlocker = false;
  if (coverage.active >= 5 && coverage.coveragePct !== null) {
    if (coverage.coveragePct >= 95) { coverageEarned = 0.75; coverageStatus = 'pass'; }
    else if (coverage.coveragePct >= 75) { coverageEarned = 0.5; coverageStatus = 'warn'; }
    else { coverageEarned = 0; coverageStatus = 'fail'; coverageBlocker = coverage.active >= 10; }
  }
  addCheck(checks, 'pumpportal_coverage', 'Per-token exact-trade coverage', 0.75, coverageEarned, coverageStatus,
    coverage.active < 5 ? `collecting; ${coverage.active} recently active Pump.fun tokens`
      : `${coverage.coveragePct}% (${coverage.fresh}/${coverage.active}) have a trade event within four minutes`, coverageBlocker);

  const heliusBlocked = Object.values(helius.groups || {}).some((group: any) => group.blocked);
  const heliusHealthy = helius.configured && !heliusBlocked && Number(helius.http429Pct || 0) < 1;
  addCheck(checks, 'helius', 'Helius request protection', 1, heliusHealthy ? 1 : helius.configured && !heliusBlocked ? 0.7 : 0,
    heliusHealthy ? 'pass' : helius.configured && !heliusBlocked ? 'warn' : 'fail',
    helius.configured
      ? `${helius.successPct}% success; ${helius.got429} × 429; circuits ${heliusBlocked ? 'blocked' : 'open'}`
      : 'HELIUS_API_KEY missing', !heliusHealthy && !warmup);

  const jupiterConfigured = !!env.JUPITER_API_KEY;
  addCheck(checks, 'jupiter', 'Jupiter quote API', 0.5, jupiterConfigured ? 0.5 : 0,
    jupiterConfigured ? 'pass' : 'fail', jupiterConfigured ? 'JUPITER_API_KEY configured' : 'JUPITER_API_KEY missing', !jupiterConfigured);

  const simulationWallet = String(process.env.SIMULATION_WALLET || '').trim();
  const simulationWalletValid = SOLANA_ADDRESS.test(simulationWallet);
  addCheck(checks, 'simulation_wallet', 'Simulation wallet public address', 0.75, simulationWalletValid ? 0.75 : 0,
    simulationWalletValid ? 'pass' : 'fail', simulationWalletValid
      ? `configured (${simulationWallet.slice(0, 4)}…${simulationWallet.slice(-4)})`
      : 'set SIMULATION_WALLET to the public address of the wallet you would actually trade from', !simulationWalletValid);

  const executionProven = paper.transactionBuilt > 0 && paper.simulationOk > 0;
  addCheck(checks, 'execution_proof', 'Entry transaction build and simulation', 1,
    executionProven ? 1 : simulationWalletValid && jupiterConfigured ? 0.25 : 0,
    executionProven ? 'pass' : simulationWalletValid && jupiterConfigured ? 'collecting' : 'fail',
    executionProven
      ? `${paper.transactionBuilt} transactions built; ${paper.simulationOk} simulations succeeded; epoch ${paper.executionEpochAt || 'active'}`
      : simulationWalletValid && jupiterConfigured ? 'configured; waiting for the next qualifying paper call'
        : 'cannot prove executable entries until Jupiter and SIMULATION_WALLET are configured', !executionProven && !warmup);

  const telegramConfigured = telegram.configured;
  const lastTelegramSuccess = telegram.lastSuccessAt ? Date.parse(telegram.lastSuccessAt) : 0;
  const telegramFresh = lastTelegramSuccess > 0 && Date.now() - lastTelegramSuccess <= 26 * 60 * 60_000;
  addCheck(checks, 'telegram', 'Telegram delivery canary', 0.75,
    telegramFresh ? 0.75 : telegramConfigured ? 0.35 : 0,
    telegramFresh ? 'pass' : telegramConfigured ? 'collecting' : 'fail',
    telegramFresh ? `last accepted ${telegram.lastSuccessAt}; latency ${telegram.lastLatencyMs ?? 'unknown'}ms`
      : telegramConfigured ? 'credentials configured; waiting for the delayed boot canary or a real alert'
        : 'Telegram bot token or chat ID missing', !telegramConfigured);

  const recentPct = paper.recentTrackingLostPct;
  let trackingEarned = 1;
  let trackingStatus: ReadinessCheck['status'] = 'collecting';
  let trackingBlocker = false;
  let trackingDetail = `collecting; ${paper.recentClosed} calls closed in the last 24 hours`;
  if (paper.recentClosed >= 5 && recentPct !== null) {
    trackingDetail = `${recentPct}% tracking_lost (${paper.recentTrackingLost}/${paper.recentClosed}) in the last 24 hours`;
    if (recentPct <= 5) trackingStatus = 'pass';
    else if (recentPct <= 15) { trackingStatus = 'warn'; trackingEarned = 0.6; }
    else { trackingStatus = 'fail'; trackingEarned = 0; trackingBlocker = true; }
  }
  addCheck(checks, 'tracking', 'Paper outcome continuity', 1, trackingEarned, trackingStatus, trackingDetail, trackingBlocker);

  const adminKey = String(env.ADMIN_KEY || '').trim();
  const adminStrong = adminKey.length >= 20;
  addCheck(checks, 'admin_security', 'Private admin-route authentication', 0.75, adminStrong ? 0.75 : 0,
    adminStrong ? 'pass' : 'fail', adminStrong
      ? 'ADMIN_KEY configured; protected tools require the dashboard session key'
      : 'set a random ADMIN_KEY of at least 20 characters in Railway', !adminStrong);

  const shadowSafe = cfg().signal_model.mode === 'shadow' && process.env.LIVE_TRADING_ENABLED !== 'true';
  addCheck(checks, 'shadow_safety', 'No real-money broadcasting', 1, shadowSafe ? 1 : 0,
    shadowSafe ? 'pass' : 'fail', shadowSafe
      ? 'Signal Stack remains shadow-only and no live trading flag is enabled'
      : 'live execution must remain disabled until executable evidence clears promotion gates', !shadowSafe);

  const earned = checks.reduce((sum, check) => sum + check.earned, 0);
  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  const score = round1(earned / total * 10);
  const blockers = checks.filter(check => check.blocker && check.status === 'fail').map(check => check.detail);
  const warnings = checks.filter(check => check.status === 'warn' || check.status === 'collecting').map(check => check.detail);
  const status = warmup ? 'warming_up'
    : score >= 9.5 && blockers.length === 0 ? 'private_ready'
      : score >= 8 ? 'near_ready'
        : 'shadow_only';

  const nextActions = checks
    .filter(check => check.status === 'fail' || check.status === 'warn')
    .sort((left, right) => Number(right.blocker) - Number(left.blocker) || right.weight - left.weight)
    .map(check => check.detail)
    .slice(0, 6);

  return {
    score10: score,
    status,
    warmup,
    privateUseOnly: true,
    liveTradingReady: false,
    blockers,
    warnings,
    nextActions,
    checks,
    streamCoverage: coverage,
    generatedAt: new Date().toISOString(),
  };
}
