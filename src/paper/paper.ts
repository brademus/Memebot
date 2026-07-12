import { pool } from '../db';
import { getToken } from '../store';

// ===== PAPER TRADING =====
// User's idea: the moment the bot SUGGESTS a coin, pretend to buy it and track what
// it would have won or lost. This is genuinely valuable — but for a specific reason.
// Existing outcome logging measures a coin from FIRST SCORE. It cannot tell you
// whether a *suggestion's timing* was good: a coin can be a loser from birth but a
// winner from the moment the smart lane flagged it. Paper-trading each suggestion at
// the instant it's made isolates ENTRY-TIMING quality per signal type.
//
// HONESTY: this is idealized — no slippage, no gas, perfect fills at the mark price.
// It is a TIMING BENCHMARK, not a claim of real P&L. Reported as such.

export type PaperSignal = 'trigger' | 'conviction' | 'bb_smart' | 'bb_organic' | 'bb_pregrad' | 'bb_secondwave';

// open a paper position the instant a suggestion is made (idempotent per ca+signal)
export async function openPaper(ca: string, symbol: string, signal: PaperSignal, price: number, score: number | null) {
  if (!pool || !price || price <= 0) return;
  await pool.query(
    `INSERT INTO paper_trades (ca, symbol, signal, entry_price, entry_score, peak_price, peak_at, last_price, last_at)
     VALUES ($1,$2,$3,$4,$5,$4,now(),$4,now())
     ON CONFLICT (ca, signal) DO NOTHING`,
    [ca, symbol, signal, price, score]).catch(() => {});
}

// mark-to-market + exit logic, every 60s
export function startPaperTrader() {
  if (!pool) return;
  setInterval(() => mark().catch(() => {}), 60_000);
}

async function mark() {
  if (!pool) return;
  const open = await pool.query(`SELECT ca, signal, entry_price, entry_at, peak_price FROM paper_trades WHERE closed = false`).catch(() => ({ rows: [] as any[] }));
  for (const row of open.rows) {
    const t = getToken(row.ca);
    // if the coin has evicted from memory, close at last known (can't mark further)
    if (!t || !t.priceUsd || t.priceUsd <= 0) {
      if (!t) await closeAt(row.ca, row.signal, null, 'coin left watchlist — closed at last mark');
      continue;
    }
    const price = t.priceUsd;
    const peak = Math.max(Number(row.peak_price) || 0, price);
    await pool.query(
      `UPDATE paper_trades SET last_price = $3, last_at = now(),
              peak_price = $4, peak_at = CASE WHEN $4 > peak_price THEN now() ELSE peak_at END
       WHERE ca = $1 AND signal = $2 AND closed = false`,
      [row.ca, row.signal, price, peak]).catch(() => {});

    // signal-agnostic paper EXITS — mirror how a disciplined trader would manage the
    // position, so the benchmark reflects a realistic hold, not hold-to-zero:
    //  - take profit: +100% from entry (2x) locks a win
    //  - stop: -50% from entry cuts a loser
    //  - trailing: gave back 60% of peak gain after being up >=50%
    //  - time: 24h max hold (memecoins resolve fast)
    const mult = price / Number(row.entry_price);
    const ageH = (Date.now() - new Date(row.entry_at).getTime()) / 3600_000;
    const peakMult = peak / Number(row.entry_price);
    let exit: string | null = null;
    if (mult >= 2) exit = 'take-profit +100%';
    else if (mult <= 0.5) exit = 'stop -50%';
    else if (peakMult >= 1.5 && price <= peak * (1 - 0.6 * (1 - 1 / peakMult))) exit = `trailing stop (peak ${peakMult.toFixed(2)}x)`;
    else if (t.state === 'DEAD') exit = 'coin died';
    else if (ageH >= 24) exit = '24h time exit';
    if (exit) await closeAt(row.ca, row.signal, price, exit);
  }
}

async function closeAt(ca: string, signal: string, price: number | null, reason: string) {
  if (!pool) return;
  await pool.query(
    `UPDATE paper_trades
       SET closed = true, exit_at = now(), exit_reason = $3,
           exit_price = COALESCE($4, last_price, entry_price)
     WHERE ca = $1 AND signal = $2 AND closed = false`,
    [ca, signal, reason, price]).catch(() => {});
}

// scoreboard for the report + dashboard: per-signal timing performance
export async function paperScoreboard(days = 7): Promise<any[]> {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT signal,
           COUNT(*) AS trades,
           COUNT(*) FILTER (WHERE closed) AS closed,
           ROUND(AVG(COALESCE(exit_price, last_price) / NULLIF(entry_price,0))::numeric, 2) AS avg_return,
           ROUND((COUNT(*) FILTER (WHERE COALESCE(exit_price, last_price) / NULLIF(entry_price,0) >= 2))::numeric
                 / NULLIF(COUNT(*),0) * 100, 1) AS pct_2x,
           ROUND((COUNT(*) FILTER (WHERE COALESCE(exit_price, last_price) / NULLIF(entry_price,0) >= 1))::numeric
                 / NULLIF(COUNT(*),0) * 100, 1) AS pct_green,
           ROUND(MAX(peak_price / NULLIF(entry_price,0))::numeric, 1) AS best
    FROM paper_trades
    WHERE entry_at > now() - ($1 || ' days')::interval
    GROUP BY signal ORDER BY avg_return DESC NULLS LAST`, [String(days)]).catch(() => []);
  return (r as any).rows || [];
}

export async function paperDiag() {
  if (!pool) return { open: 0, total: 0 };
  const r = await pool.query(`SELECT COUNT(*) FILTER (WHERE NOT closed) AS open, COUNT(*) AS total FROM paper_trades`).catch(() => ({ rows: [{ open: 0, total: 0 }] }));
  return { open: Number(r.rows[0].open), total: Number(r.rows[0].total) };
}
