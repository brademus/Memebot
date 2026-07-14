-- MEMEWATCH schema. Worker runs this on boot (idempotent).

CREATE TABLE IF NOT EXISTS tokens (
  ca TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  creator TEXT,
  source TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  gate_result TEXT,
  gate_fail_reason TEXT,
  first_score_price NUMERIC,
  peak_score NUMERIC DEFAULT 0,
  last_state TEXT,
  last_score NUMERIC,
  subs JSONB
);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS subs JSONB;

CREATE TABLE IF NOT EXISTS outcomes (
  ca TEXT REFERENCES tokens(ca),
  snapshot_minutes INT,
  price_usd NUMERIC,
  liquidity_usd NUMERIC,
  mcap_usd NUMERIC,
  multiple_from_first NUMERIC,
  taken_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (ca, snapshot_minutes)
);

CREATE TABLE IF NOT EXISTS deployers (
  wallet TEXT PRIMARY KEY,
  tokens_launched INT DEFAULT 1,
  rugs INT DEFAULT 0,
  blacklisted BOOLEAN DEFAULT FALSE,
  last_seen TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS smart_wallets (
  wallet TEXT PRIMARY KEY,
  type TEXT,
  win_rate_30d NUMERIC,
  tokens_traded INT,
  last_validated TIMESTAMPTZ,
  active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_tokens_first_seen ON tokens(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_multiple ON outcomes(multiple_from_first DESC);

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS triggered_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS trigger_price NUMERIC;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS insider_pct NUMERIC;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS winners_hit INT DEFAULT 0;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS discovered_from TEXT;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS first_discovered TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS wallet_hits (
  ca TEXT,
  wallet TEXT,
  at TIMESTAMPTZ DEFAULT now(),
  buy_at TIMESTAMPTZ DEFAULT now(),
  buy_price NUMERIC,
  PRIMARY KEY (ca, wallet)
);
ALTER TABLE wallet_hits ADD COLUMN IF NOT EXISTS buy_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE wallet_hits ADD COLUMN IF NOT EXISTS buy_price NUMERIC;
CREATE INDEX IF NOT EXISTS idx_wallet_hits_due ON wallet_hits(buy_at);

CREATE TABLE IF NOT EXISTS wallet_hit_outcomes (
  ca TEXT NOT NULL,
  wallet TEXT NOT NULL,
  snapshot_minutes INT NOT NULL,
  price_usd NUMERIC,
  multiple_from_buy NUMERIC,
  taken_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (ca, wallet, snapshot_minutes)
);

CREATE TABLE IF NOT EXISTS wallet_winners (
  wallet TEXT, ca TEXT, PRIMARY KEY (wallet, ca)
);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mined_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS early_buyers TEXT[] DEFAULT '{}';
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_price DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS filter_overrides (
  path TEXT PRIMARY KEY,
  value DOUBLE PRECISION NOT NULL,
  reason TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS filter_tuning_log (
  id SERIAL PRIMARY KEY,
  at TIMESTAMPTZ DEFAULT now(),
  path TEXT NOT NULL,
  old_value DOUBLE PRECISION,
  new_value DOUBLE PRECISION,
  evidence TEXT
);

CREATE TABLE IF NOT EXISTS ai_conviction (
  ca TEXT PRIMARY KEY,
  symbol TEXT,
  verdict TEXT,
  delta INTEGER,
  reason TEXT,
  at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS quality_verdict TEXT;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS win_rate NUMERIC;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS round_trips INT;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS quality_checked_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS early_subs JSONB;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS early_subs_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS learned_weights (
  component TEXT PRIMARY KEY,
  weight DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS weight_tuning_log (
  id SERIAL PRIMARY KEY,
  at TIMESTAMPTZ DEFAULT now(),
  component TEXT,
  old_weight DOUBLE PRECISION,
  new_weight DOUBLE PRECISION,
  evidence TEXT
);

ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS deployer_rep TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS insider_cluster_pct NUMERIC;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS secondwave_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS secondwave_price NUMERIC;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS runtime JSONB;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS runtime_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS paper_trades (
  id BIGSERIAL PRIMARY KEY,
  ca TEXT NOT NULL,
  symbol TEXT,
  signal TEXT NOT NULL,
  entry_price NUMERIC NOT NULL,
  mark_entry_price NUMERIC,
  entry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_score NUMERIC,
  peak_price NUMERIC,
  peak_at TIMESTAMPTZ,
  last_price NUMERIC,
  last_at TIMESTAMPTZ,
  exit_price NUMERIC,
  exit_at TIMESTAMPTZ,
  exit_reason TEXT,
  closed BOOLEAN NOT NULL DEFAULT false,
  target_multiple NUMERIC NOT NULL DEFAULT 3,
  observed_target_hit_at TIMESTAMPTZ,
  target_hit_at TIMESTAMPTZ,
  seconds_to_target INTEGER,
  execution_eligible BOOLEAN NOT NULL DEFAULT false,
  quote_status TEXT NOT NULL DEFAULT 'legacy_mark',
  position_sol NUMERIC,
  position_usd NUMERIC,
  quoted_out_usd NUMERIC,
  quoted_out_amount NUMERIC,
  price_impact_pct NUMERIC,
  slippage_bps INTEGER,
  fee_lamports BIGINT,
  router TEXT,
  quote_time_ms INTEGER,
  exit_quote_status TEXT,
  exit_quoted_usd NUMERIC,
  exit_price_impact_pct NUMERIC,
  exit_fee_lamports BIGINT,
  exit_router TEXT,
  exit_quote_time_ms INTEGER,
  UNIQUE (ca, signal)
);

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS target_multiple NUMERIC NOT NULL DEFAULT 3;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS observed_target_hit_at TIMESTAMPTZ;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS target_hit_at TIMESTAMPTZ;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS seconds_to_target INTEGER;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS mark_entry_price NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS execution_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS quote_status TEXT NOT NULL DEFAULT 'legacy_mark';
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS position_sol NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS position_usd NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS quoted_out_usd NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS quoted_out_amount NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS price_impact_pct NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS slippage_bps INTEGER;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS fee_lamports BIGINT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS router TEXT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS quote_time_ms INTEGER;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_quote_status TEXT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_quoted_usd NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_price_impact_pct NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_fee_lamports BIGINT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_router TEXT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_quote_time_ms INTEGER;

-- Preserve every historical market observation. Old entry-only Jupiter rows are not
-- round-trip verified, so move their target timestamp to the observed column once.
UPDATE paper_trades
   SET observed_target_hit_at = target_hit_at
 WHERE observed_target_hit_at IS NULL AND target_hit_at IS NOT NULL;
UPDATE paper_trades
   SET target_hit_at = NULL, seconds_to_target = NULL
 WHERE execution_eligible = true
   AND target_hit_at IS NOT NULL
   AND exit_quote_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_paper_open ON paper_trades(closed) WHERE closed = false;
CREATE INDEX IF NOT EXISTS idx_paper_signal ON paper_trades(signal);
CREATE INDEX IF NOT EXISTS idx_paper_target_hit ON paper_trades(target_hit_at) WHERE target_hit_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paper_observed_hit ON paper_trades(observed_target_hit_at) WHERE observed_target_hit_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paper_executable ON paper_trades(execution_eligible, signal, entry_at DESC);

-- Forward-evidence v2: keep post-patch recommendations and exact-time training rows
-- separate from legacy discovery-price labels.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS trigger_model_version TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_model_version TEXT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS model_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS quote_attempted_at TIMESTAMPTZ;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS quote_key_present BOOLEAN;

CREATE TABLE IF NOT EXISTS score_snapshots (
  id BIGSERIAL PRIMARY KEY,
  ca TEXT NOT NULL REFERENCES tokens(ca),
  snapshot_age_min INTEGER NOT NULL,
  captured_age_seconds INTEGER NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  price_usd NUMERIC NOT NULL,
  score NUMERIC NOT NULL,
  raw JSONB NOT NULL,
  source TEXT,
  recommendation_eligible BOOLEAN NOT NULL DEFAULT true,
  model_version TEXT NOT NULL,
  forward_minutes INTEGER NOT NULL DEFAULT 60,
  forward_price_usd NUMERIC,
  forward_multiple NUMERIC,
  resolved_at TIMESTAMPTZ,
  resolve_status TEXT NOT NULL DEFAULT 'pending',
  resolve_attempts INTEGER NOT NULL DEFAULT 0,
  last_resolve_error TEXT,
  next_resolve_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ca, snapshot_age_min, model_version)
);
CREATE INDEX IF NOT EXISTS idx_score_snapshots_due
  ON score_snapshots(resolve_status, next_resolve_at, captured_at);
CREATE INDEX IF NOT EXISTS idx_score_snapshots_model
  ON score_snapshots(model_version, snapshot_age_min, resolved_at);

CREATE TABLE IF NOT EXISTS model_suggestions (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  evidence TEXT,
  applied BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_model_suggestions_recent
  ON model_suggestions(model_version, created_at DESC);
