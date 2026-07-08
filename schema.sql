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
