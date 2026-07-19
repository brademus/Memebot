-- MEMEWATCH call-telemetry schema. Loaded after schema-v3.sql and safe to run on every boot.

-- Immutable/reproducible context captured when a paper observation or buy call opens,
-- plus summary fields that make outcome research queryable without unpacking JSON.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS entry_context JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_context JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS config_snapshot JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS stream_snapshot JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS rank_snapshot JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS feature_snapshot JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS burst_snapshot JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS token_snapshot JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS conviction_snapshot JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS trigger_snapshot JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS coverage_snapshot JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS trough_price NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS trough_at TIMESTAMPTZ;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS max_runup_pct NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS max_drawdown_pct NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS final_multiple NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS pnl_pct NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS snapshot_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exact_trade_events_at_entry INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exact_trade_events_during_call INTEGER NOT NULL DEFAULT 0;

-- Market-path snapshots are adaptive: very dense immediately after entry, then less
-- frequent as a call ages. Each row stores both query-friendly columns and the complete
-- structured observation used by research/modeling code.
CREATE TABLE IF NOT EXISTS paper_trade_snapshots (
  id BIGSERIAL PRIMARY KEY,
  paper_trade_id BIGINT NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
  ca TEXT NOT NULL,
  signal TEXT NOT NULL,
  model_version TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_age_seconds INTEGER NOT NULL,
  bucket_seconds INTEGER NOT NULL,
  cadence_seconds INTEGER NOT NULL,
  phase TEXT NOT NULL,
  price_usd NUMERIC,
  multiple NUMERIC,
  peak_multiple NUMERIC,
  trough_multiple NUMERIC,
  runup_pct NUMERIC,
  drawdown_pct NUMERIC,
  liquidity_usd NUMERIC,
  mcap_usd NUMERIC,
  liquidity_mcap_ratio NUMERIC,
  vol_5m NUMERIC,
  buys_5m INTEGER,
  sells_5m INTEGER,
  buy_sell_ratio NUMERIC,
  total_buys INTEGER,
  total_sells INTEGER,
  unique_buyers INTEGER,
  curve_sol NUMERIC,
  peak_curve_sol NUMERIC,
  score NUMERIC,
  peak_score NUMERIC,
  state TEXT,
  stream_mode TEXT,
  exact_trade_events INTEGER NOT NULL DEFAULT 0,
  feature_vector JSONB,
  burst_features JSONB,
  subscores JSONB,
  rank JSONB,
  social JSONB,
  bundle JSONB,
  entity_graph JSONB,
  smart_wallets JSONB,
  model_decision JSONB,
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL,
  UNIQUE (paper_trade_id, bucket_seconds)
);
CREATE INDEX IF NOT EXISTS idx_paper_trade_snapshots_trade_time
  ON paper_trade_snapshots(paper_trade_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_paper_trade_snapshots_ca_time
  ON paper_trade_snapshots(ca, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trade_snapshots_model
  ON paper_trade_snapshots(model_version, signal, captured_at DESC);

-- Append-only lifecycle ledger. The dedupe key prevents repeated 15-second marking
-- passes from creating duplicate target/close/quote events.
CREATE TABLE IF NOT EXISTS paper_trade_events (
  id BIGSERIAL PRIMARY KEY,
  paper_trade_id BIGINT NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
  ca TEXT NOT NULL,
  signal TEXT NOT NULL,
  model_version TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  price_usd NUMERIC,
  multiple NUMERIC,
  state TEXT,
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (paper_trade_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_paper_trade_events_trade_time
  ON paper_trade_events(paper_trade_id, at);
CREATE INDEX IF NOT EXISTS idx_paper_trade_events_type_time
  ON paper_trade_events(event_type, at DESC);

-- Make research joins from exact Pump.fun events to a call window efficient.
CREATE INDEX IF NOT EXISTS idx_trade_events_ca_at_asc ON trade_events(ca, at);

-- One stable labeled row per observation/call. Training jobs can use this view directly
-- and join paper_trade_snapshots or trade_events by paper_trade_id/ca when sequence data
-- is required. Entry-side fields remain immutable; outcome-side fields mature over time.
CREATE OR REPLACE VIEW call_training_examples AS
SELECT
  p.id AS paper_trade_id,
  p.ca,
  p.symbol,
  p.signal,
  p.model_version,
  p.signal_decision_id,
  p.entry_at,
  p.entry_price,
  p.mark_entry_price,
  p.entry_score,
  p.entry_context,
  p.config_snapshot,
  p.stream_snapshot,
  p.rank_snapshot,
  p.feature_snapshot,
  p.burst_snapshot,
  p.token_snapshot,
  p.conviction_snapshot,
  p.trigger_snapshot,
  p.coverage_snapshot,
  p.execution_eligible,
  p.quote_status,
  p.transaction_built,
  p.simulation_ok,
  p.simulation_error,
  p.execution_score,
  p.route_stability_bps,
  p.execution_probe,
  p.position_sol,
  p.position_usd,
  p.price_impact_pct,
  p.slippage_bps,
  p.router,
  p.quote_time_ms,
  p.closed,
  p.exit_at,
  p.exit_reason,
  p.exit_price,
  p.exit_context,
  p.final_multiple,
  p.pnl_pct,
  p.peak_price,
  p.trough_price,
  p.max_runup_pct,
  p.max_drawdown_pct,
  p.duration_seconds,
  p.observed_target_hit_at,
  p.target_hit_at,
  p.seconds_to_target,
  p.snapshot_count,
  p.event_count,
  p.exact_trade_events_at_entry,
  p.exact_trade_events_during_call,
  CASE WHEN p.final_multiple >= 3 THEN true ELSE false END AS reached_3x,
  CASE WHEN p.final_multiple >= 2 THEN true ELSE false END AS reached_2x,
  CASE WHEN p.final_multiple <= 0.5 THEN true ELSE false END AS severe_loss,
  CASE WHEN p.closed AND p.exit_reason IS DISTINCT FROM 'tracking_lost' THEN true ELSE false END AS label_resolved
FROM paper_trades p;
