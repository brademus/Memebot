-- MEMEWATCH schema. Worker runs this on boot (idempotent).

CREATE TABLE IF NOT EXISTS tokens (
  ca TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  creator TEXT,
  source TEXT,                        -- pumpfun | dexscreener
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  gate_result TEXT,                   -- passed | failed
  gate_fail_reason TEXT,
  first_score_price NUMERIC,          -- price when first scored (for EXTENDED calc)
  peak_score NUMERIC DEFAULT 0,
  last_state TEXT,
  last_score NUMERIC,
  subs JSONB
);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS subs JSONB;

CREATE TABLE IF NOT EXISTS outcomes (
  ca TEXT REFERENCES tokens(ca),
  snapshot_minutes INT,               -- 60 / 240 / 1440
  price_usd NUMERIC,
  liquidity_usd NUMERIC,
  mcap_usd NUMERIC,
  multiple_from_first NUMERIC,        -- price / first_score_price
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

CREATE TABLE IF NOT EXISTS smart_wallets (       -- Phase 3, table ready now
  wallet TEXT PRIMARY KEY,
  type TEXT,                          -- sniper | whale_accumulator | kol_linked
  win_rate_30d NUMERIC,
  tokens_traded INT,
  last_validated TIMESTAMPTZ,
  active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_tokens_first_seen ON tokens(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_multiple ON outcomes(multiple_from_first DESC);

-- v2 additions (idempotent)
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS triggered_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS trigger_price NUMERIC;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS insider_pct NUMERIC;

-- wallet tracking additions (idempotent)
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS winners_hit INT DEFAULT 0;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS discovered_from TEXT;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS first_discovered TIMESTAMPTZ DEFAULT now();
CREATE TABLE IF NOT EXISTS wallet_hits (      -- live: a tracked wallet bought a token we're watching
  ca TEXT, wallet TEXT, at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (ca, wallet)
);

-- wallet discovery v2 (idempotent)
CREATE TABLE IF NOT EXISTS wallet_winners (
  wallet TEXT, ca TEXT, PRIMARY KEY (wallet, ca)
);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mined_at TIMESTAMPTZ;

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS early_buyers TEXT[] DEFAULT '{}';

-- CONVICTION tier (added 2026-07): measured separately from triggers so the
-- weekly review can compare precision between the two alert tiers.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_price DOUBLE PRECISION;

-- FILTER LEARNING (added 2026-07): the bot's learned threshold adjustments.
-- Overrides survive redeploys (Railway resets config.yaml); the log is the
-- audit trail every change must leave.
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

-- AI narrative read (added 2026-07): logged per token so the weekly report can
-- PROVE whether the AI's verdict correlates with outcomes. If it doesn't, disable it.
CREATE TABLE IF NOT EXISTS ai_conviction (
  ca TEXT PRIMARY KEY,
  symbol TEXT,
  verdict TEXT,
  delta INTEGER,
  reason TEXT,
  at TIMESTAMPTZ DEFAULT now()
);

-- wallet quality (added 2026-07): independent P&L judgment, breaks the circular
-- "only wallets from our own winners" limitation.
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS quality_verdict TEXT;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS win_rate NUMERIC;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS round_trips INT;
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS quality_checked_at TIMESTAMPTZ;

-- SCORING CALIBRATION (added 2026-07): the closed loop that makes the score
-- fit outcomes over time. early_subs = sub-scores frozen at a fixed young age,
-- so we learn what predicted winners BEFORE they ran (the live subs column gets
-- overwritten as a token matures and is useless for prediction). learned_weights
-- persists the fitted weights across redeploys (Railway wipes config.yaml).
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

-- wallet activity recency (added 2026-07): copy-trading needs wallets ACTIVE TODAY,
-- not historical qualifiers sitting idle. last_active updates every time a tracked
-- wallet's buy hits the webhook; ranking + surfacing gate on it.
ALTER TABLE smart_wallets ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ;

-- research-driven features 2026-07 (deployer reputation, cluster merge, second wave)
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS deployer_rep TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS insider_cluster_pct NUMERIC;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS secondwave_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS secondwave_price NUMERIC;

-- warm-boot hydration (2026-07): deploys/restarts no longer reset the watchlist.
-- runtime holds a JSON snapshot of live token state, flushed every 45s and on
-- SIGTERM (Railway sends it before every redeploy); boot rehydrates from it.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS runtime JSONB;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS runtime_at TIMESTAMPTZ;
