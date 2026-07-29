-- BTC research subsystem. It stores hypothetical calls only. No credentials, signing material,
-- exchange balances, or executable order endpoints belong in this schema.

-- Legacy v1 table retained so existing BTC evidence is never rewritten or silently mixed with v2.
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
CREATE UNIQUE INDEX IF NOT EXISTS btc_one_open_call_idx ON btc_calls ((status)) WHERE status='open';
CREATE INDEX IF NOT EXISTS btc_calls_opened_idx ON btc_calls (opened_at DESC);
CREATE INDEX IF NOT EXISTS btc_calls_strategy_idx ON btc_calls (strategy_version,opened_at DESC);

CREATE TABLE IF NOT EXISTS btc_strategy_definitions (
  strategy_id TEXT PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  description TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('actionable','shadow')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS btc_strategy_versions (
  strategy_id TEXT NOT NULL REFERENCES btc_strategy_definitions(strategy_id),
  strategy_version TEXT NOT NULL,
  leverage_cap INTEGER NOT NULL CHECK (leverage_cap BETWEEN 1 AND 50),
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  code_fingerprint TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (strategy_id,strategy_version)
);

CREATE TABLE IF NOT EXISTS btc_signal_candidates (
  candidate_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  setup_type TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('actionable','shadow')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  entry_method TEXT NOT NULL,
  preferred_entry DOUBLE PRECISION NOT NULL CHECK (preferred_entry>0),
  entry_zone_low DOUBLE PRECISION NOT NULL CHECK (entry_zone_low>0),
  entry_zone_high DOUBLE PRECISION NOT NULL CHECK (entry_zone_high>0),
  do_not_chase_price DOUBLE PRECISION NOT NULL CHECK (do_not_chase_price>0),
  structural_stop DOUBLE PRECISION NOT NULL CHECK (structural_stop>0),
  initial_target DOUBLE PRECISION NOT NULL CHECK (initial_target>0),
  extended_target DOUBLE PRECISION,
  maximum_realistic_target DOUBLE PRECISION NOT NULL CHECK (maximum_realistic_target>0),
  minimum_rr DOUBLE PRECISION NOT NULL CHECK (minimum_rr>0),
  strategy_leverage_cap INTEGER NOT NULL CHECK (strategy_leverage_cap BETWEEN 1 AND 50),
  scores JSONB NOT NULL,
  rationale JSONB NOT NULL,
  features JSONB NOT NULL,
  decision_status TEXT NOT NULL DEFAULT 'pending' CHECK (decision_status IN ('pending','approved','rejected','merged','expired','missed')),
  decision_reason TEXT,
  decided_at TIMESTAMPTZ,
  FOREIGN KEY (strategy_id,strategy_version) REFERENCES btc_strategy_versions(strategy_id,strategy_version)
);
CREATE INDEX IF NOT EXISTS btc_candidates_created_idx ON btc_signal_candidates(created_at DESC);
CREATE INDEX IF NOT EXISTS btc_candidates_strategy_idx ON btc_signal_candidates(strategy_id,strategy_version,created_at DESC);

CREATE TABLE IF NOT EXISTS btc_risk_decisions (
  decision_id BIGSERIAL PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES btc_signal_candidates(candidate_id),
  book TEXT NOT NULL CHECK (book IN ('research','actionable')),
  approved BOOLEAN NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  margin_usd DOUBLE PRECISION NOT NULL DEFAULT 100,
  leverage INTEGER NOT NULL CHECK (leverage BETWEEN 0 AND 50),
  notional_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_price DOUBLE PRECISION,
  stop_price DOUBLE PRECISION,
  target_price DOUBLE PRECISION,
  extended_target_price DOUBLE PRECISION,
  liquidation_price DOUBLE PRECISION,
  liquidation_buffer_pct DOUBLE PRECISION,
  estimated_risk_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  estimated_reward_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  estimated_net_rr DOUBLE PRECISION NOT NULL DEFAULT 0,
  estimated_target_roi_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  estimated_costs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS btc_risk_candidate_idx ON btc_risk_decisions(candidate_id,created_at DESC);

CREATE TABLE IF NOT EXISTS btc_paper_calls (
  call_id TEXT PRIMARY KEY,
  book TEXT NOT NULL CHECK (book IN ('research','actionable')),
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  supporting_strategies JSONB NOT NULL DEFAULT '[]'::jsonb,
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  status TEXT NOT NULL CHECK (status IN ('armed','open','partial','won','lost','closed','liquidated','missed','cancelled')),
  margin_usd DOUBLE PRECISION NOT NULL CHECK (margin_usd>0),
  leverage INTEGER NOT NULL CHECK (leverage BETWEEN 1 AND 50),
  notional_usd DOUBLE PRECISION NOT NULL CHECK (notional_usd>0),
  entry_price DOUBLE PRECISION NOT NULL CHECK (entry_price>0),
  current_price DOUBLE PRECISION NOT NULL CHECK (current_price>0),
  stop_price DOUBLE PRECISION NOT NULL CHECK (stop_price>0),
  target_price DOUBLE PRECISION NOT NULL CHECK (target_price>0),
  extended_target_price DOUBLE PRECISION,
  liquidation_price DOUBLE PRECISION NOT NULL CHECK (liquidation_price>0),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  exit_price DOUBLE PRECISION,
  exit_reason TEXT,
  realized_pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  unrealized_pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  roi_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  current_r DOUBLE PRECISION NOT NULL DEFAULT 0,
  result_r DOUBLE PRECISION,
  max_favorable_r DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_adverse_r DOUBLE PRECISION NOT NULL DEFAULT 0,
  remaining_fraction DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (remaining_fraction BETWEEN 0 AND 1),
  runner_activated BOOLEAN NOT NULL DEFAULT false,
  trailing_stop_price DOUBLE PRECISION,
  fees_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  funding_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_alert_at TIMESTAMPTZ NOT NULL,
  simulated_fill_at TIMESTAMPTZ NOT NULL,
  rationale JSONB NOT NULL DEFAULT '[]'::jsonb,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (strategy_id,strategy_version) REFERENCES btc_strategy_versions(strategy_id,strategy_version)
);
CREATE INDEX IF NOT EXISTS btc_paper_calls_book_status_idx ON btc_paper_calls(book,status,opened_at DESC);
CREATE INDEX IF NOT EXISTS btc_paper_calls_strategy_idx ON btc_paper_calls(strategy_id,strategy_version,opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS btc_one_research_call_per_strategy_idx
  ON btc_paper_calls(strategy_id) WHERE book='research' AND status IN ('armed','open','partial');

CREATE TABLE IF NOT EXISTS btc_call_events (
  event_id BIGSERIAL PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES btc_paper_calls(call_id),
  event_type TEXT NOT NULL,
  event_at TIMESTAMPTZ NOT NULL,
  price DOUBLE PRECISION,
  reason TEXT NOT NULL,
  realized_pnl_delta_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS btc_call_events_call_idx ON btc_call_events(call_id,event_at);

CREATE TABLE IF NOT EXISTS btc_fills (
  fill_id BIGSERIAL PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES btc_paper_calls(call_id),
  fill_at TIMESTAMPTZ NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  purpose TEXT NOT NULL CHECK (purpose IN ('entry','partial_exit','exit','liquidation')),
  price DOUBLE PRECISION NOT NULL CHECK (price>0),
  notional_usd DOUBLE PRECISION NOT NULL CHECK (notional_usd>=0),
  fraction DOUBLE PRECISION NOT NULL CHECK (fraction BETWEEN 0 AND 1),
  fee_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  slippage_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS btc_fills_call_idx ON btc_fills(call_id,fill_at);

CREATE TABLE IF NOT EXISTS btc_pnl_snapshots (
  snapshot_id BIGSERIAL PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES btc_paper_calls(call_id),
  snapshot_at TIMESTAMPTZ NOT NULL,
  mark_price DOUBLE PRECISION NOT NULL,
  executable_exit_price DOUBLE PRECISION NOT NULL,
  realized_pnl_usd DOUBLE PRECISION NOT NULL,
  unrealized_pnl_usd DOUBLE PRECISION NOT NULL,
  net_pnl_usd DOUBLE PRECISION NOT NULL,
  roi_pct DOUBLE PRECISION NOT NULL,
  current_r DOUBLE PRECISION NOT NULL,
  liquidation_buffer_pct DOUBLE PRECISION NOT NULL,
  UNIQUE (call_id,snapshot_at)
);
CREATE INDEX IF NOT EXISTS btc_pnl_snapshots_at_idx ON btc_pnl_snapshots(snapshot_at DESC);

CREATE TABLE IF NOT EXISTS btc_alert_deliveries (
  delivery_id BIGSERIAL PRIMARY KEY,
  call_id TEXT REFERENCES btc_paper_calls(call_id),
  candidate_id TEXT REFERENCES btc_signal_candidates(candidate_id),
  alert_type TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('dashboard','telegram')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped','stale')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  external_message_id TEXT,
  error_kind TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS btc_alert_deliveries_call_idx ON btc_alert_deliveries(call_id,created_at DESC);

CREATE TABLE IF NOT EXISTS btc_market_snapshots (
  snapshot_at TIMESTAMPTZ PRIMARY KEY,
  reference_venue TEXT NOT NULL,
  last_price DOUBLE PRECISION NOT NULL,
  bid_price DOUBLE PRECISION NOT NULL,
  ask_price DOUBLE PRECISION NOT NULL,
  mark_price DOUBLE PRECISION NOT NULL,
  index_price DOUBLE PRECISION NOT NULL,
  funding_rate DOUBLE PRECISION NOT NULL,
  open_interest DOUBLE PRECISION NOT NULL,
  regime JSONB NOT NULL,
  feed_quality JSONB NOT NULL,
  derivatives JSONB NOT NULL,
  order_flow JSONB NOT NULL
);

-- Database-level portfolio guards. They deliberately cover the actionable book only;
-- independent strategy research calls are limited separately by the unique index above.
CREATE OR REPLACE FUNCTION btc_v2_enforce_actionable_limits()
RETURNS trigger AS $$
DECLARE
  local_day_start TIMESTAMPTZ;
  calls_today INTEGER;
  active_calls INTEGER;
  active_notional DOUBLE PRECISION;
BEGIN
  IF NEW.book <> 'actionable' THEN RETURN NEW; END IF;
  local_day_start := date_trunc('day', NEW.opened_at AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago';
  SELECT COUNT(*)::int INTO calls_today FROM btc_paper_calls
   WHERE book='actionable' AND opened_at>=local_day_start AND opened_at<local_day_start+interval '1 day';
  SELECT COUNT(*)::int,COALESCE(SUM(notional_usd*remaining_fraction),0)
    INTO active_calls,active_notional FROM btc_paper_calls
   WHERE book='actionable' AND status IN ('armed','open','partial');
  IF calls_today>=12 THEN RAISE EXCEPTION 'BTC actionable daily call limit reached'; END IF;
  IF active_calls>=3 THEN RAISE EXCEPTION 'BTC actionable active-call limit reached'; END IF;
  IF active_notional+NEW.notional_usd>7500 THEN RAISE EXCEPTION 'BTC actionable notional limit reached'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS btc_v2_actionable_limits ON btc_paper_calls;
CREATE TRIGGER btc_v2_actionable_limits BEFORE INSERT ON btc_paper_calls
FOR EACH ROW EXECUTE FUNCTION btc_v2_enforce_actionable_limits();
