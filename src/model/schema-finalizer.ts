import { pool } from '../db';

export async function finalizeSignalSchema() {
  if (!pool) return;
  await pool.query(`
    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_ca_signal_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_unique_model
      ON paper_trades(ca, signal, model_version);
    CREATE INDEX IF NOT EXISTS idx_paper_signal_decision
      ON paper_trades(signal_decision_id) WHERE signal_decision_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS model_parameters (
      id BIGSERIAL PRIMARY KEY,
      model_version TEXT NOT NULL,
      kind TEXT NOT NULL,
      parameters JSONB NOT NULL,
      metrics JSONB NOT NULL,
      active BOOLEAN NOT NULL DEFAULT false,
      sample_count INTEGER NOT NULL DEFAULT 0,
      trained_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_model_parameters_active
      ON model_parameters(model_version, kind, active, trained_at DESC);
  `);
}
