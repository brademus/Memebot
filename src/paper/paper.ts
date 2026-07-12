import { pool } from '../db';
import { getToken } from '../store';

// ===== PAPER TRADING =====
// Every suggestion is measured from the exact alert-time mark. The primary question
// is not "did this token ever run?" but "did this specific call leave enough upside
// for a disciplined user to capture 3x from the suggested entry?"
//
// HONESTY: marks are still idealized — no slippage, gas, failed fills, or latency.
// This is an ENTRY-TIMING benchmark, not a claim of executable P&L.

export type PaperSignal = 'trigger' | 'conviction' | 'bb_smart' | 'bb_organic' | 'bb_pregrad' | 'bb_secondwave';

const TARGET_MULTIPLE = 3;
const STOP_MULTIPLE = 0.5;
const MAX_HOLD_HOURS = 24;

// Open a paper position the instant a suggestion is made (idempotent per ca+signal).
export async function openPaper(ca: string, symbol: string, signal: PaperSignal, price: number, score: number | null) {
  if (!pool || !price || price <= 0) return;
  await pool.query(
    `INSERT INTO paper_trades
       (ca, symbol, signal, entry_price, entry_score, peak_price, peak_at, last_price, last_at, target_multiple)
     VALUES ($1,$2,$3,$4,$5,$4,now(),$4,now(),$6)
     ON CONFLICT (ca, signal) DO NOTHING`,
    [ca, symbol, signal, price, score, TARGET_MULTIPLE]).catch(() => {});
}

// Mark-to-market + exit logic, every 60s.
export function startPaperTrader() {
  if (!pool) return;
  setInterval(() => mark().catch(() => {}), 60_000);
}

async function mark() {
  if (!pool) return;
  const open = await pool.query(
    `SELECT ca, signal, entry_price, entry_at, peak_price, target_hit_at
       FROM paper_trades
      WHERE closed = false`).catch(() => ({ rows: [] as any[] }));

  for (const row of open.rows) {
    const t = getToken(row.ca);

    // Eviction is not proof of a loss. Preserve the last observed mark and classify
    // the sample as incomplete rather than fabricating a zero or stale-price exit.
    if (!t || !t.priceUsd || t.priceUsd <= 0) {
      if (!t) await closeAt(row.ca, row.signal, null, 'tracking_lost');
      continue;
    }

    const entry = Number(row.entry_price);
    const price = t.priceUsd;
    const previousPeak = Number(row.peak_price) || entry;
    const peak = Math.max(previousPeak, price);
    const mult = price / entry;
    const peakMult = peak / entry;
    const ageH = (Date.now() - new Date(row.entry_at).getTime()) / 3600_000;
    const firstTargetHit = !row.target_hit_at && peakMult >= TARGET_MULTIPLE;

    await pool.query(
      `UPDATE paper_trades
          SET last_price = $3,
              last_at = now(),
              peak_price = $4,
              peak_at = CASE WHEN $4 > peak_price THEN now() ELSE peak_at END,
              target_hit_at = CASE WHEN target_hit_at IS NULL AND $5 THEN now() ELSE target_hit_at END,
              seconds_to_target = CASE
                WHEN seconds_to_target IS NULL AND $5
                THEN EXTRACT(EPOCH FROM (now() - entry_at))::int
                ELSE seconds_to_target
              END
        WHERE ca = $1 AND signal = $2 AND closed = false`,
      [row.ca, row.signal, price, peak, firstTargetHit]).catch(() => {});

    // The 3x hit is recorded as soon as observed, then the benchmark closes at 3x.
    // That isolates whether the alert was early enough; it does not pretend a user
    // sold the exact wick. Separate executable-fill modeling comes next.
    let exit: string | null = null;
    let exitPrice: number | null = price;
    if (peakMult >= TARGET_MULTIPLE) {
      exit = 'target_3x_hit';
      exitPrice = entry * TARGET_MULTIPLE;
    } else if (mult <= STOP_MULTIPLE) {
      exit = 'stop_50pct';
    } else if (t.state === 'DEAD') {
      exit = 'coin_died';
    } else if (ageH >= MAX_HOLD_HOURS) {
      exit = 'time_24h';
    }

    if (exit) await closeAt(row.ca, row.signal, exitPrice, exit);
  }
}

async function closeAt(ca: string, signal: string, price: number | null, reason: string) {
  if (!pool) return;
  await pool.query(
    `UPDATE paper_trades
        SET closed = true,
            exit_at = now(),
            exit_reason = $3,
            exit_price = COALESCE($4, last_price, entry_price)
      WHERE ca = $1 AND signal = $2 AND closed = false`,
    [ca, signal, reason, price]).catch(() => {});
}

// Scoreboard centered on the user's actual objective: calls that reached 3x from
// alert-time entry, and how quickly they did it.
export async function paperScoreboard(days = 7): Promise<any[]> {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT signal,
           COUNT(*) AS trades,
           COUNT(*) FILTER (WHERE closed) AS closed,
           COUNT(*) FILTER (WHERE exit_reason = 'tracking_lost') AS incomplete,
           ROUND(AVG(COALESCE(exit_price, last_price) / NULLIF(entry_price,0))::numeric, 2) AS avg_return,
           ROUND((COUNT(*) FILTER (WHERE target_hit_at IS NOT NULL))::numeric
                 / NULLIF(COUNT(*) FILTER (WHERE exit_reason IS DISTINCT FROM 'tracking_lost'),0) * 100, 1) AS pct_3x,
           ROUND((COUNT(*) FILTER (WHERE COALESCE(exit_price, last_price) / NULLIF(entry_price,0) >= 1))::numeric
                 / NULLIF(COUNT(*),0) * 100, 1) AS pct_green,
           ROUND(MAX(peak_price / NULLIF(entry_price,0))::numeric, 2) AS best,
           ROUND(AVG(seconds_to_target) FILTER (WHERE seconds_to_target IS NOT NULL) / 60.0, 1) AS avg_minutes_to_3x,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds_to_target)
             FILTER (WHERE seconds_to_target IS NOT NULL) / 60.0 AS median_minutes_to_3x
      FROM paper_trades
     WHERE entry_at > now() - ($1 || ' days')::interval
     GROUP BY signal
     ORDER BY pct_3x DESC NULLS LAST, avg_return DESC NULLS LAST`, [String(days)]).catch(() => []);
  return (r as any).rows || [];
}

export async function paperDiag() {
  if (!pool) return { open: 0, total: 0, hit3x: 0 };
  const r = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE NOT closed) AS open,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE target_hit_at IS NOT NULL) AS hit3x
      FROM paper_trades`).catch(() => ({ rows: [{ open: 0, total: 0, hit3x: 0 }] }));
  return {
    open: Number(r.rows[0].open),
    total: Number(r.rows[0].total),
    hit3x: Number(r.rows[0].hit3x),
  };
}
