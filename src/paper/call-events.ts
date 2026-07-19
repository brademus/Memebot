import { pool } from '../db';
import { TokenRecord } from '../types';
import { recordPaperEvent } from './telemetry';

export async function recordLatestPaperEvent(
  ca: string,
  signal: string,
  modelVersion: string,
  token: TokenRecord | null,
  eventType: string,
  dedupeKey: string,
  price: number | null,
  reason: string | null,
  payload: unknown,
  at = Date.now(),
): Promise<boolean> {
  if (!pool) return false;
  const row = await pool.query(
    `SELECT id FROM paper_trades
      WHERE ca=$1 AND signal=$2 AND model_version=$3
      ORDER BY entry_at DESC LIMIT 1`,
    [ca, signal, modelVersion],
  ).catch(() => ({ rows: [] as any[] }));
  const id = Number(row.rows[0]?.id);
  if (!id) return false;

  // Older in-memory tokens can lack a current modelDecision even though the persisted
  // paper row is versioned correctly. Normalize child telemetry to the authoritative
  // paper-row version instead of leaving an ambiguous `unknown` label.
  await pool.query(`UPDATE paper_trade_snapshots SET model_version=$2 WHERE paper_trade_id=$1`, [id, modelVersion]).catch(() => {});
  await pool.query(`UPDATE paper_trade_events SET model_version=$2 WHERE paper_trade_id=$1`, [id, modelVersion]).catch(() => {});

  return recordPaperEvent(id, token, signal, modelVersion, eventType, dedupeKey, price, reason, payload, at);
}
