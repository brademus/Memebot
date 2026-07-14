import { pool } from '../db';

export async function finalizeSignalSchema() {
  if (!pool) return;
  // The v2 table used UNIQUE(ca, signal), which would let a historical call suppress a
  // new model-version call for the same token. Versioned evidence must coexist.
  await pool.query(`
    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_ca_signal_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_unique_model
      ON paper_trades(ca, signal, model_version);
    CREATE INDEX IF NOT EXISTS idx_paper_signal_decision
      ON paper_trades(signal_decision_id) WHERE signal_decision_id IS NOT NULL;
  `);
}
