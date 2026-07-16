-- MEMEWATCH signal-v3 schema. Loaded after schema.sql and safe to run on every boot.

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS entity_graph JSONB;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS model_decision JSONB;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS model_decision_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS regime_id TEXT;

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS transaction_built BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS simulation_ok BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS simulation_error TEXT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS simulation_units BIGINT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS route_stability_bps NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS execution_score NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS execution_probe JSONB;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS signal_decision_id BIGINT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_transaction_built BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_simulation_ok BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_simulation_error TEXT;

CREATE TABLE IF NOT EXISTS trade_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  ca TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  side TEXT NOT NULL,
  wallet TEXT,
  sol_amount NUMERIC,
  token_amount NUMERIC,
  price_usd NUMERIC,
  curve_sol NUMERIC,
  slot BIGINT,
  signature TEXT,
  source TEXT NOT NULL DEFAULT 'pumpfun',
  UNIQUE (ca, event_id)
);
CREATE INDEX IF NOT EXISTS idx_trade_events_ca_at ON trade_events(ca, at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_events_wallet_at ON trade_events(wallet, at DESC) WHERE wallet IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_funding_roots (
  wallet TEXT PRIMARY KEY,
  root_wallet TEXT NOT NULL,
  immediate_funder TEXT,
  first_seen_at TIMESTAMPTZ,
  first_funded_at TIMESTAMPTZ,
  funding_amount_sol NUMERIC,
  funding_source TEXT,
  confidence NUMERIC NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_funding_root ON wallet_funding_roots(root_wallet, checked_at DESC);

CREATE TABLE IF NOT EXISTS token_entity_features (
  ca TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  buyers_analyzed INTEGER NOT NULL,
  independent_entities INTEGER NOT NULL,
  independence_ratio NUMERIC NOT NULL,
  largest_entity_buyer_pct NUMERIC NOT NULL,
  largest_entity_supply_pct NUMERIC NOT NULL,
  common_funder_buyer_pct NUMERIC NOT NULL,
  fresh_wallet_pct NUMERIC NOT NULL,
  deployer_linked_pct NUMERIC NOT NULL,
  funding_time_concentration NUMERIC NOT NULL,
  graph_risk NUMERIC NOT NULL,
  roots INTEGER NOT NULL,
  complete BOOLEAN NOT NULL,
  details JSONB
);
CREATE INDEX IF NOT EXISTS idx_token_entity_risk ON token_entity_features(graph_risk, checked_at DESC);

CREATE TABLE IF NOT EXISTS regime_snapshots (
  id BIGSERIAL PRIMARY KEY,
  regime_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  launches_1h INTEGER NOT NULL,
  pass_rate NUMERIC NOT NULL,
  median_change_5m NUMERIC NOT NULL,
  aggregate_buy_ratio NUMERIC NOT NULL,
  median_liquidity_usd NUMERIC NOT NULL,
  route_health NUMERIC NOT NULL,
  change_probability NUMERIC NOT NULL,
  completeness NUMERIC NOT NULL,
  metrics JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regime_observed ON regime_snapshots(observed_at DESC);

CREATE TABLE IF NOT EXISTS signal_observations (
  id BIGSERIAL PRIMARY KEY,
  ca TEXT NOT NULL,
  observation_key TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_age_seconds INTEGER NOT NULL,
  price_usd NUMERIC NOT NULL,
  base_score NUMERIC NOT NULL,
  source TEXT NOT NULL,
  dex TEXT,
  regime_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  recommendation_eligible BOOLEAN NOT NULL,
  feature_vector JSONB NOT NULL,
  burst_features JSONB NOT NULL,
  entity_features JSONB,
  decision JSONB,
  UNIQUE (ca, observation_key, model_version)
);
CREATE INDEX IF NOT EXISTS idx_signal_observations_model ON signal_observations(model_version, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_observations_regime ON signal_observations(regime_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS signal_observation_outcomes (
  observation_id BIGINT NOT NULL REFERENCES signal_observations(id) ON DELETE CASCADE,
  horizon_minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  price_usd NUMERIC,
  multiple NUMERIC,
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (observation_id, horizon_minutes)
);
CREATE INDEX IF NOT EXISTS idx_signal_observation_outcomes_due ON signal_observation_outcomes(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS execution_probes (
  id BIGSERIAL PRIMARY KEY,
  ca TEXT NOT NULL,
  model_version TEXT NOT NULL,
  probed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction TEXT NOT NULL,
  input_amount TEXT,
  requested_sol NUMERIC,
  status TEXT NOT NULL,
  eligible BOOLEAN NOT NULL,
  transaction_built BOOLEAN NOT NULL,
  simulation_ok BOOLEAN NOT NULL,
  simulation_error TEXT,
  units_consumed BIGINT,
  router TEXT,
  mode TEXT,
  price_impact NUMERIC,
  route_stability_bps NUMERIC,
  execution_score NUMERIC,
  probes JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_probes_ca ON execution_probes(ca, probed_at DESC);

CREATE TABLE IF NOT EXISTS signal_decisions (
  id BIGSERIAL PRIMARY KEY,
  ca TEXT NOT NULL,
  symbol TEXT,
  model_version TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  allow BOOLEAN NOT NULL,
  preliminary_pass BOOLEAN NOT NULL,
  reasons TEXT[] NOT NULL DEFAULT '{}',
  regime_id TEXT NOT NULL,
  source TEXT NOT NULL,
  price_usd NUMERIC NOT NULL,
  base_score NUMERIC NOT NULL,
  alpha_score NUMERIC NOT NULL,
  cohort_percentile NUMERIC NOT NULL,
  cohort_size INTEGER NOT NULL,
  target_before_stop_probability NUMERIC NOT NULL,
  downside_probability NUMERIC NOT NULL,
  expected_value NUMERIC NOT NULL,
  uncertainty NUMERIC NOT NULL,
  hazards JSONB NOT NULL,
  features JSONB NOT NULL,
  execution JSONB,
  decision_hash TEXT NOT NULL,
  UNIQUE (ca, model_version, decision_hash)
);
CREATE INDEX IF NOT EXISTS idx_signal_decisions_current ON signal_decisions(model_version, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_decisions_allow ON signal_decisions(model_version, allow, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS signal_decision_outcomes (
  decision_id BIGINT PRIMARY KEY REFERENCES signal_decisions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'tracking',
  entry_price NUMERIC NOT NULL,
  last_price NUMERIC,
  last_multiple NUMERIC,
  max_multiple NUMERIC NOT NULL DEFAULT 1,
  min_multiple NUMERIC NOT NULL DEFAULT 1,
  first_event TEXT,
  first_event_at TIMESTAMPTZ,
  route_lost_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  tracking_gap BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signal_decision_outcomes_status ON signal_decision_outcomes(status, updated_at);

CREATE TABLE IF NOT EXISTS model_calibration_bins (
  model_version TEXT NOT NULL,
  regime_kind TEXT NOT NULL,
  probability_bin INTEGER NOT NULL,
  observations INTEGER NOT NULL,
  successes INTEGER NOT NULL,
  posterior_probability NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_version, regime_kind, probability_bin)
);

CREATE TABLE IF NOT EXISTS model_evaluations (
  id BIGSERIAL PRIMARY KEY,
  model_version TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  train_rows INTEGER NOT NULL,
  test_rows INTEGER NOT NULL,
  metrics JSONB NOT NULL,
  regime_metrics JSONB NOT NULL,
  placebo_metrics JSONB NOT NULL,
  passed_falsification BOOLEAN NOT NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_evaluations_recent ON model_evaluations(model_version, evaluated_at DESC);

-- FIX (review 2026-07-14): openPaper targets ON CONFLICT (ca, signal, model_version)
-- but no matching unique index existed — only the legacy UNIQUE(ca, signal). Postgres
-- rejects every such INSERT ('no unique or exclusion constraint matching the ON
-- CONFLICT specification'), and the error was swallowed, so ZERO paper trades were
-- recorded since v3 shipped: the entire promotion evidence stream was silently dead.
ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_ca_signal_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_trades_ca_signal_model
  ON paper_trades(ca, signal, model_version);

-- leadership priority (2026-07-15): the public domain is bound to ONE instance; if
-- that instance loses the advisory-lock race, the domain serves standby stubs
-- indefinitely (observed live: 8/8 requests -> standby). A waiting PRIMARY instance
-- registers a claim here; a non-primary leader sees the fresh claim and yields.
CREATE TABLE IF NOT EXISTS leadership_claims (
  name TEXT PRIMARY KEY,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
