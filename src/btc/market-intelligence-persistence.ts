import { pool } from '../db';
import { getBtcMarketIntelligence, startBtcMarketIntelligence } from './market-intelligence';

let started = false;
let timer: NodeJS.Timeout | null = null;

async function initialize(): Promise<void> {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS btc_market_intelligence_snapshots (
    snapshot_at timestamptz PRIMARY KEY,
    healthy boolean NOT NULL,
    blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
    coinbase_depth_imbalance_5bps double precision,
    kraken_depth_imbalance_5bps double precision,
    consolidated_spot_depth_imbalance_5bps double precision,
    coinbase_trade_delta_usd_10s double precision NOT NULL DEFAULT 0,
    kraken_trade_delta_usd_10s double precision NOT NULL DEFAULT 0,
    deribit_perpetual_open_interest double precision,
    deribit_funding_rate double precision,
    deribit_basis_bps double precision,
    btc_iv_7d double precision,
    btc_iv_30d double precision,
    btc_25d_skew double precision,
    iv_term_slope double precision,
    option_contracts_observed integer NOT NULL DEFAULT 0,
    venue_ages_ms jsonb NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS btc_market_intelligence_snapshot_at_idx
    ON btc_market_intelligence_snapshots(snapshot_at DESC)`);
}

async function persist(): Promise<void> {
  if (!pool) return;
  const at = new Date(Math.floor(Date.now() / 5_000) * 5_000);
  const latest = await pool.query(`SELECT mark_price,last_price FROM btc_market_snapshots
    ORDER BY snapshot_at DESC LIMIT 1`).catch(() => ({ rows: [] as any[] }));
  const reference = Number(latest.rows[0]?.mark_price || latest.rows[0]?.last_price || 0);
  if (!(reference > 0)) return;
  const snapshot = getBtcMarketIntelligence(reference, at.getTime());
  await pool.query(`INSERT INTO btc_market_intelligence_snapshots (
    snapshot_at,healthy,blockers,coinbase_depth_imbalance_5bps,kraken_depth_imbalance_5bps,
    consolidated_spot_depth_imbalance_5bps,coinbase_trade_delta_usd_10s,kraken_trade_delta_usd_10s,
    deribit_perpetual_open_interest,deribit_funding_rate,deribit_basis_bps,btc_iv_7d,btc_iv_30d,
    btc_25d_skew,iv_term_slope,option_contracts_observed,venue_ages_ms
  ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
  ON CONFLICT(snapshot_at) DO UPDATE SET
    healthy=EXCLUDED.healthy,blockers=EXCLUDED.blockers,
    coinbase_depth_imbalance_5bps=EXCLUDED.coinbase_depth_imbalance_5bps,
    kraken_depth_imbalance_5bps=EXCLUDED.kraken_depth_imbalance_5bps,
    consolidated_spot_depth_imbalance_5bps=EXCLUDED.consolidated_spot_depth_imbalance_5bps,
    coinbase_trade_delta_usd_10s=EXCLUDED.coinbase_trade_delta_usd_10s,
    kraken_trade_delta_usd_10s=EXCLUDED.kraken_trade_delta_usd_10s,
    deribit_perpetual_open_interest=EXCLUDED.deribit_perpetual_open_interest,
    deribit_funding_rate=EXCLUDED.deribit_funding_rate,deribit_basis_bps=EXCLUDED.deribit_basis_bps,
    btc_iv_7d=EXCLUDED.btc_iv_7d,btc_iv_30d=EXCLUDED.btc_iv_30d,btc_25d_skew=EXCLUDED.btc_25d_skew,
    iv_term_slope=EXCLUDED.iv_term_slope,option_contracts_observed=EXCLUDED.option_contracts_observed,
    venue_ages_ms=EXCLUDED.venue_ages_ms`, [
    at, snapshot.healthy, JSON.stringify(snapshot.blockers), snapshot.coinbaseDepthImbalance5Bps,
    snapshot.krakenDepthImbalance5Bps, snapshot.consolidatedSpotDepthImbalance5Bps,
    snapshot.coinbaseTradeDeltaUsd10s, snapshot.krakenTradeDeltaUsd10s,
    snapshot.deribitPerpetualOpenInterest, snapshot.deribitFundingRate, snapshot.deribitBasisBps,
    snapshot.btcIv7d, snapshot.btcIv30d, snapshot.btc25dSkew, snapshot.ivTermSlope,
    snapshot.optionContractsObserved, JSON.stringify(snapshot.venueAgesMs),
  ]);
}

export async function startBtcMarketIntelligencePersistence(): Promise<void> {
  if (started) return;
  started = true;
  startBtcMarketIntelligence();
  await initialize();
  await persist().catch(error => console.error('[btc-market-intelligence]', (error as Error).message));
  timer = setInterval(() => void persist().catch(error => console.error('[btc-market-intelligence]', (error as Error).message)), 5_000);
  timer.unref();
  console.log('[btc] compact Deribit/options and multi-venue L2 research snapshots active');
}
