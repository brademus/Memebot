import { cfg } from '../config';
import { addToken, getToken } from '../store';
import { AppConfig, TokenRecord } from '../types';
import { appendMarketSample } from './dexscreener';

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const DURATIONS = ['1h', '6h', '24h'] as const;

// Major assets, stables and liquid-staking tokens are not meme revival calls.
const EXCLUDE = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
]);

const retryAfter = new Map<string, number>();
const surfacedAt = new Map<string, number>();
const diag = {
  lastRun: null as string | null,
  lastError: null as string | null,
  requests: 0,
  poolsScanned: 0,
  uniqueTokens: 0,
  eligible: 0,
  surfaced: 0,
  rejected: {} as Record<string, number>,
};
export const agedDiag = () => ({ ...diag, rejected: { ...diag.rejected } });

export interface AgedPoolMetrics {
  ageHours: number;
  liquidityUsd: number;
  mcapUsd: number;
  liquidityMcapRatio: number;
  volume24hUsd: number;
  volume1hUsd: number;
  volumeLiquidity24h: number;
  txns1h: number;
  buys1h: number;
  sells1h: number;
  buyRatio1h: number;
  change5mPct: number;
  change1hPct: number;
  change24hPct: number;
  quality: number;
}

export interface AgedAssessment {
  eligible: boolean;
  reason: string | null;
  metrics: AgedPoolMetrics;
}

const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function assessAgedPool(
  attributes: any,
  now = Date.now(),
  settings: AppConfig['aged'] = cfg().aged,
): AgedAssessment {
  const createdAt = Date.parse(String(attributes?.pool_created_at || ''));
  const ageHours = Number.isFinite(createdAt) ? Math.max(0, (now - createdAt) / 3_600_000) : 0;
  const liquidityUsd = number(attributes?.reserve_in_usd);
  const mcapUsd = number(attributes?.market_cap_usd) || number(attributes?.fdv_usd);
  const volume24hUsd = number(attributes?.volume_usd?.h24);
  const volume1hUsd = number(attributes?.volume_usd?.h1);
  const buys1h = number(attributes?.transactions?.h1?.buys);
  const sells1h = number(attributes?.transactions?.h1?.sells);
  const txns1h = buys1h + sells1h;
  const buyRatio1h = sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? buys1h : 0;
  const change5mPct = number(attributes?.price_change_percentage?.m5);
  const change1hPct = number(attributes?.price_change_percentage?.h1);
  const change24hPct = number(attributes?.price_change_percentage?.h24);
  const liquidityMcapRatio = mcapUsd > 0 ? liquidityUsd / mcapUsd : 0;
  const volumeLiquidity24h = liquidityUsd > 0 ? volume24hUsd / liquidityUsd : 0;

  let reason: string | null = null;
  if (!Number.isFinite(createdAt)) reason = 'creation_time_unknown';
  else if (ageHours < settings.min_age_hours) reason = 'too_young';
  else if (ageHours > settings.max_age_hours) reason = 'too_old';
  else if (liquidityUsd < settings.min_liquidity_usd) reason = 'liquidity';
  else if (mcapUsd < settings.min_mcap_usd || mcapUsd > settings.max_mcap_usd) reason = 'market_cap';
  else if (liquidityMcapRatio < settings.min_liquidity_mcap_ratio) reason = 'liquidity_mcap';
  else if (volume24hUsd < settings.min_vol24h_usd) reason = 'volume_24h';
  else if (volume1hUsd < settings.min_vol1h_usd) reason = 'volume_1h';
  else if (volumeLiquidity24h < settings.min_volume_liquidity_24h) reason = 'turnover';
  else if (txns1h < settings.min_txns_1h) reason = 'transactions_1h';
  else if (buyRatio1h < settings.min_buy_ratio_1h) reason = 'buy_ratio_1h';
  else if (change1hPct < settings.min_change1h_pct || change1hPct > settings.max_change1h_pct) reason = 'change_1h';
  else if (change24hPct < settings.min_change24h_pct || change24hPct > settings.max_change24h_pct) reason = 'change_24h';
  else if (change5mPct > settings.max_change5m_pct) reason = 'five_minute_chase';

  const activity = Math.min(2, volume1hUsd / Math.max(1, settings.min_vol1h_usd));
  const breadth = Math.min(2, txns1h / Math.max(1, settings.min_txns_1h));
  const pressure = Math.min(2, buyRatio1h / Math.max(1, settings.min_buy_ratio_1h));
  const depth = Math.min(2, liquidityUsd / Math.max(1, settings.min_liquidity_usd));
  const moveQuality = Math.max(0, 1 - Math.abs(change1hPct - 12) / 40);
  const quality = activity * 0.25 + breadth * 0.20 + pressure * 0.20 + depth * 0.20 + moveQuality * 0.15;

  return {
    eligible: reason === null,
    reason,
    metrics: {
      ageHours, liquidityUsd, mcapUsd, liquidityMcapRatio, volume24hUsd, volume1hUsd,
      volumeLiquidity24h, txns1h, buys1h, sells1h, buyRatio1h,
      change5mPct, change1hPct, change24hPct, quality,
    },
  };
}

export function startAgedScanner(onFound: (ca: string) => void | Promise<void>) {
  if (!cfg().aged.enabled) return;
  const tick = () => scan(onFound).catch(error => {
    diag.lastError = (error as Error).message;
    console.error('[aged]', diag.lastError);
  });
  setTimeout(tick, 45_000);
  const timer = setInterval(tick, Math.max(180, cfg().aged.poll_seconds) * 1000);
  timer.unref();
}

async function scan(onFound: (ca: string) => void | Promise<void>) {
  const settings = cfg().aged;
  const now = Date.now();
  diag.lastRun = new Date(now).toISOString();
  diag.lastError = null;
  diag.requests = 0;
  diag.poolsScanned = 0;
  diag.uniqueTokens = 0;
  diag.eligible = 0;
  diag.surfaced = 0;
  diag.rejected = {};

  for (const [ca, until] of retryAfter) if (until <= now) retryAfter.delete(ca);
  for (const [ca, at] of surfacedAt) if (now - at > 24 * 3_600_000) surfacedAt.delete(ca);

  const byToken = new Map<string, { pool: any; assessment: AgedAssessment }>();
  for (const duration of DURATIONS) {
    for (let page = 1; page <= settings.pages_per_duration; page++) {
      const response = await fetch(`${GT}/trending_pools?duration=${duration}&page=${page}`, {
        headers: { accept: 'application/json' },
      }).catch(() => null);
      diag.requests++;
      if (!response?.ok) continue;
      const body: any = await response.json().catch(() => null);
      for (const pool of body?.data || []) {
        diag.poolsScanned++;
        const ca = String(pool.relationships?.base_token?.data?.id || '').replace(/^solana_/, '');
        if (!ca || EXCLUDE.has(ca)) continue;
        const assessment = assessAgedPool(pool.attributes, now, settings);
        const prior = byToken.get(ca);
        if (!prior || assessment.metrics.quality > prior.assessment.metrics.quality) {
          byToken.set(ca, { pool, assessment });
        }
      }
    }
  }

  diag.uniqueTokens = byToken.size;
  const candidates: Array<{ ca: string; pool: any; assessment: AgedAssessment }> = [];
  for (const [ca, item] of byToken) {
    if (!item.assessment.eligible) {
      const reason = item.assessment.reason || 'unknown';
      diag.rejected[reason] = (diag.rejected[reason] || 0) + 1;
      retryAfter.set(ca, now + rejectionDelay(reason));
      continue;
    }
    diag.eligible++;
    if (getToken(ca) || (retryAfter.get(ca) || 0) > now || surfacedAt.has(ca)) continue;
    candidates.push({ ca, ...item });
  }

  candidates.sort((left, right) => right.assessment.metrics.quality - left.assessment.metrics.quality);
  for (const candidate of candidates.slice(0, settings.max_surfaced_per_run)) {
    const token = addToken({
      ca: candidate.ca,
      symbol: String(candidate.pool.attributes?.name || '').split(' / ')[0]?.trim() || '?',
      name: `(aged revival: ${candidate.pool.attributes?.name || candidate.ca.slice(0, 8)})`,
      creator: null,
      source: 'aged',
    });
    if (!token) continue;
    seedAgedToken(token, candidate.pool, candidate.assessment, now);
    surfacedAt.set(candidate.ca, now);
    diag.surfaced++;
    console.log(`[aged] surfaced $${token.symbol} age=${candidate.assessment.metrics.ageHours.toFixed(0)}h `
      + `liq=$${Math.round(token.liquidityUsd / 1000)}K h1=${candidate.assessment.metrics.change1hPct.toFixed(1)}% `
      + `flow=${candidate.assessment.metrics.buys1h}:${candidate.assessment.metrics.sells1h}`);
    await onFound(candidate.ca);
  }
}

function seedAgedToken(token: TokenRecord, pool: any, assessment: AgedAssessment, now: number) {
  const attributes = pool.attributes || {};
  token.playType = 'REVIVAL';
  token.marketCreatedAt = Date.parse(String(attributes.pool_created_at || '')) || null;
  token.dexId = pool.relationships?.dex?.data?.id || 'raydium';
  token.dex = token.dexId;
  token.priceUsd = number(attributes.base_token_price_usd);
  token.liquidityUsd = assessment.metrics.liquidityUsd;
  token.mcapUsd = assessment.metrics.mcapUsd;
  token.vol5m = number(attributes.volume_usd?.m5);
  token.buys5m = number(attributes.transactions?.m5?.buys);
  token.sells5m = number(attributes.transactions?.m5?.sells);
  token.priceChange5m = assessment.metrics.change5mPct;
  token.pairAddress = String(pool.id || '').replace(/^solana_/, '') || null;
  appendMarketSample(token, now);
}

function rejectionDelay(reason: string): number {
  if (reason === 'five_minute_chase' || reason === 'change_1h') return 30 * 60_000;
  if (reason === 'buy_ratio_1h' || reason === 'transactions_1h' || reason === 'volume_1h') return 2 * 3_600_000;
  return 6 * 3_600_000;
}
