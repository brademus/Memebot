import { pool } from '../db';
import { allTokens } from '../store';
import { MarketRegime, RegimeKind } from '../types';
import { clamp01, mean, percentile, round } from './math';

const history: MarketRegime[] = [];
let current: MarketRegime = {
  id: 'boot-normal', kind: 'normal', observedAt: Date.now(), launches1h: 0,
  passRate: 0, medianChange5m: 0, aggregateBuyRatio: 1, medianLiquidityUsd: 0,
  routeHealth: 0.7, changeProbability: 0, completeness: 0,
};
const diag = { lastRun: null as string | null, lastError: null as string | null, changes: 0 };
export const currentRegime = () => current;
export const regimeDiag = () => ({ ...diag, current, history: history.slice(-12) });

export function classifyRegime(metrics: Omit<MarketRegime, 'id' | 'kind' | 'observedAt' | 'changeProbability'>): RegimeKind {
  if (metrics.routeHealth < 0.45 || metrics.aggregateBuyRatio < 0.75 || metrics.medianChange5m < -12) return 'adverse';
  if (metrics.launches1h >= 2500 && metrics.aggregateBuyRatio >= 1.45 && metrics.medianChange5m >= 8) return 'mania';
  if (metrics.launches1h >= 1200 && metrics.aggregateBuyRatio >= 1.15 && metrics.medianChange5m >= 2) return 'hot';
  if ((metrics.launches1h > 0 && metrics.launches1h < 250) || (metrics.passRate > 0 && metrics.passRate < 0.12) || metrics.aggregateBuyRatio < 0.9) return 'cold';
  return 'normal';
}
export function startRegimeEngine() {
  const tick = () => refreshRegime().catch(error => { diag.lastError = (error as Error).message; console.error('[regime]', diag.lastError); });
  setTimeout(tick, 5_000);
  const timer = setInterval(tick, 60_000); timer.unref();
}
export async function refreshRegime(): Promise<MarketRegime> {
  const live = allTokens().filter(token => token.firstSeen >= Date.now() - 3_600_000);
  const changes = live.map(token => token.priceChange5m).filter(Number.isFinite);
  const liquidity = live.map(token => token.liquidityUsd).filter(value => value > 0);
  const buys = live.reduce((sum, token) => sum + Math.max(0, token.buys5m), 0);
  const sells = live.reduce((sum, token) => sum + Math.max(0, token.sells5m), 0);
  let launches1h = live.length;
  let passRate = live.length ? live.filter(token => token.gated === true).length / live.length : 0;
  let routeHealth = 0.7;
  let routeSamples = 0;
  if (pool) {
    const database = await pool.query(
      `SELECT COUNT(*)::int AS launches,COALESCE(AVG(CASE WHEN gate_result='passed' THEN 1.0 ELSE 0 END),0) AS pass_rate
         FROM tokens WHERE first_seen>now()-interval '1 hour'`,
    ).catch(() => ({ rows: [] as any[] }));
    if (database.rows.length) { launches1h = Number(database.rows[0].launches) || launches1h; passRate = Number(database.rows[0].pass_rate) || passRate; }
    const routes = await pool.query(
      `SELECT COUNT(*)::int AS n,AVG(CASE WHEN eligible AND simulation_ok THEN 1.0 ELSE 0 END) AS route_health
         FROM execution_probes WHERE probed_at>now()-interval '1 hour'`,
    ).catch(() => ({ rows: [] as any[] }));
    routeSamples = Number(routes.rows[0]?.n) || 0;
    if (routeSamples > 0) routeHealth = Number(routes.rows[0]?.route_health) || 0;
  }
  const metrics = {
    launches1h, passRate: clamp01(passRate), medianChange5m: percentile(changes, 0.5),
    aggregateBuyRatio: sells > 0 ? buys / sells : buys > 0 ? 3 : 1,
    medianLiquidityUsd: percentile(liquidity, 0.5), routeHealth,
    completeness: clamp01(0.35 * Math.min(1, live.length / 100) + 0.25 * (changes.length ? 1 : 0)
      + 0.20 * (liquidity.length ? 1 : 0) + 0.20 * Math.min(1, routeSamples / 10)),
  };
  const provisionalKind = classifyRegime(metrics);
  const previous = history[history.length - 1];
  const changeProbability = previous ? regimeDistance(previous, metrics) : 0;
  const kind: RegimeKind = previous && changeProbability > 0.75 && provisionalKind !== previous.kind ? 'transition' : provisionalKind;
  const observedAt = Date.now();
  current = {
    id: `${new Date(observedAt).toISOString().slice(0, 13)}:${kind}`, kind, observedAt, launches1h,
    passRate: round(metrics.passRate), medianChange5m: round(metrics.medianChange5m, 2),
    aggregateBuyRatio: round(metrics.aggregateBuyRatio), medianLiquidityUsd: round(metrics.medianLiquidityUsd, 2),
    routeHealth: round(metrics.routeHealth), changeProbability: round(changeProbability), completeness: round(metrics.completeness),
  };
  if (previous && previous.kind !== current.kind) diag.changes++;
  history.push(current); if (history.length > 180) history.shift();
  diag.lastRun = new Date().toISOString(); diag.lastError = null;
  if (pool) await pool.query(
    `INSERT INTO regime_snapshots
       (regime_id,kind,observed_at,launches_1h,pass_rate,median_change_5m,aggregate_buy_ratio,median_liquidity_usd,
        route_health,change_probability,completeness,metrics)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [current.id,current.kind,current.observedAt,current.launches1h,current.passRate,current.medianChange5m,
     current.aggregateBuyRatio,current.medianLiquidityUsd,current.routeHealth,current.changeProbability,current.completeness,JSON.stringify(current)],
  ).catch(() => {});
  return current;
}
function regimeDistance(previous: MarketRegime, next: Omit<MarketRegime, 'id' | 'kind' | 'observedAt' | 'changeProbability'>): number {
  return clamp01(mean([
    Math.abs(next.launches1h - previous.launches1h) / Math.max(200, previous.launches1h),
    Math.abs(next.passRate - previous.passRate) / 0.25,
    Math.abs(next.medianChange5m - previous.medianChange5m) / 20,
    Math.abs(Math.log(Math.max(0.1, next.aggregateBuyRatio) / Math.max(0.1, previous.aggregateBuyRatio))) / Math.log(3),
    Math.abs(next.routeHealth - previous.routeHealth) / 0.5,
  ]));
}
