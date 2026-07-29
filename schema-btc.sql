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

CREATE OR REPLACE FUNCTION btc_enforce_daily_paper_limits()
RETURNS trigger AS $$
DECLARE
  local_day_start TIMESTAMPTZ;
  calls_today INTEGER;
  losses_today INTEGER;
BEGIN
  local_day_start := date_trunc('day', NEW.opened_at AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago';
  SELECT COUNT(*)::int, COUNT(*) FILTER (WHERE status='lost')::int
    INTO calls_today, losses_today
    FROM btc_calls
   WHERE opened_at >= local_day_start
     AND opened_at < local_day_start + interval '1 day';
  IF calls_today >= 2 THEN
    RAISE EXCEPTION 'BTC paper daily call limit reached';
  END IF;
  IF losses_today >= 2 THEN
    RAISE EXCEPTION 'BTC paper daily loss circuit breaker reached';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS btc_daily_paper_limits ON btc_calls;
CREATE TRIGGER btc_daily_paper_limits
  BEFORE INSERT ON btc_calls
  FOR EACH ROW EXECUTE FUNCTION btc_enforce_daily_paper_limits();
