-- BTC paper-research subsystem. No credentials, signing material, or executable orders.

CREATE TABLE IF NOT EXISTS btc_calls (
  id TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  entry_price DOUBLE PRECISION NOT NULL CHECK (entry_price > 0),
  stop_price DOUBLE PRECISION NOT NULL CHECK (stop_price > 0),
  target_price DOUBLE PRECISION NOT NULL CHECK (target_price > 0),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  risk_reward DOUBLE PRECISION NOT NULL CHECK (risk_reward > 0),
  status TEXT NOT NULL CHECK (status IN ('open','won','lost','closed')),
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  exit_price DOUBLE PRECISION,
  exit_reason TEXT,
  result_r DOUBLE PRECISION,
  max_favorable_r DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_adverse_r DOUBLE PRECISION NOT NULL DEFAULT 0,
  setup JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((direction='long' AND stop_price<entry_price AND target_price>entry_price)
      OR (direction='short' AND stop_price>entry_price AND target_price<entry_price)),
  CHECK ((status='open' AND closed_at IS NULL AND exit_price IS NULL AND result_r IS NULL)
      OR (status<>'open' AND closed_at IS NOT NULL AND exit_price IS NOT NULL AND result_r IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS btc_one_open_call_idx
  ON btc_calls ((status)) WHERE status='open';
CREATE INDEX IF NOT EXISTS btc_calls_opened_idx ON btc_calls (opened_at DESC);
CREATE INDEX IF NOT EXISTS btc_calls_strategy_idx ON btc_calls (strategy_version,opened_at DESC);
