import { pool } from '../db';
import { fetchTokenSnapshot } from '../ingest/dexscreener';

const SNAPSHOTS = [60, 240, 1440];
let started = false;
let running = false;

export async function recordWalletEntry(wallet: string, ca: string, atMs: number, price: number | null) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO wallet_hits (ca,wallet,at,buy_at,buy_price)
     VALUES ($1,$2,to_timestamp($3/1000.0),to_timestamp($3/1000.0),$4)
     ON CONFLICT (ca,wallet) DO UPDATE SET
       buy_at=LEAST(wallet_hits.buy_at,EXCLUDED.buy_at),
       buy_price=COALESCE(wallet_hits.buy_price,EXCLUDED.buy_price)`,
    [ca, wallet, atMs, price && price > 0 ? price : null],
  ).catch(() => {});
}

export async function backfillWalletEntryPrice(ca: string, price: number) {
  if (!pool || !(price > 0)) return;
  await pool.query(
    `UPDATE wallet_hits SET buy_price=$2
      WHERE ca=$1 AND buy_price IS NULL`,
    [ca, price],
  ).catch(() => {});
}

export function startWalletOutcomeLedger() {
  if (started || !pool) return;
  started = true;
  setTimeout(() => tick().catch(() => {}), 90_000);
  setInterval(() => tick().catch(() => {}), 60_000);
}

async function tick() {
  if (!pool || running) return;
  running = true;
  try {
    for (const minutes of SNAPSHOTS) {
      const due = await pool.query(
        `SELECT h.ca,h.wallet,h.buy_price
           FROM wallet_hits h
          WHERE h.buy_price IS NOT NULL
            AND h.buy_at <= now()-($1||' minutes')::interval
            AND h.buy_at > now()-interval '72 hours'
            AND NOT EXISTS (
              SELECT 1 FROM wallet_hit_outcomes o
               WHERE o.ca=h.ca AND o.wallet=h.wallet AND o.snapshot_minutes=$2)
          ORDER BY h.buy_at ASC LIMIT 150`,
        [String(minutes), minutes],
      );
      for (let index = 0; index < due.rows.length; index += 8) {
        await Promise.all(due.rows.slice(index, index + 8).map(async row => {
          const snapshot = await fetchTokenSnapshot(row.ca);
          if (!snapshot || !(snapshot.price > 0)) return;
          const buy = Number(row.buy_price);
          await pool!.query(
            `INSERT INTO wallet_hit_outcomes
               (ca,wallet,snapshot_minutes,price_usd,multiple_from_buy)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (ca,wallet,snapshot_minutes) DO NOTHING`,
            [row.ca, row.wallet, minutes, snapshot.price, buy > 0 ? snapshot.price / buy : null],
          ).catch(() => {});
        }));
      }
    }
  } finally { running = false; }
}
