import { cfg } from '../config';
import { fetchTokenSnapshot } from '../ingest/dexscreener';
import { logOutcome, markRug, pool } from '../db';

// Outcome logger v2 — reads due snapshots from Postgres instead of memory, so it:
//   (a) survives worker restarts,
//   (b) tracks KILLED tokens too — the false-kill data that tells us when gates
//       are rejecting future winners (ref price = price at kill).
// This table is the training set for weight-fitting and gate tuning.
export function startOutcomeLogger() {
  setInterval(tick, 60_000);
}

async function tick() {
  if (!pool) return;
  for (const m of cfg().polling.outcome_snapshot_minutes) {
    try {
      const due = await pool.query(
        `SELECT ca, first_score_price, gate_result FROM tokens
         WHERE first_seen <= now() - ($1 || ' minutes')::interval
           AND first_seen >  now() - interval '48 hours'
           AND first_score_price IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.ca = tokens.ca AND o.snapshot_minutes = $2)
         LIMIT 20`, [String(m), m]);
      for (const row of due.rows) {
        const snap = await fetchTokenSnapshot(row.ca);
        if (!snap) {
          // token vanished from Dexscreener = dead; log as zero so it counts as a loss, not a gap
          await logOutcome(row.ca, m, 0, 0, 0, row.first_score_price);
          continue;
        }
        await logOutcome(row.ca, m, snap.price, snap.liq, snap.mcap, row.first_score_price);
        if (row.gate_result === 'passed' && row.first_score_price && snap.price < row.first_score_price * 0.05 && cfg().deployer.blacklist_auto) {
          await markRug(row.ca);
        }
      }
    } catch (e) { console.error('[outcomes]', (e as Error).message); }
  }
}
