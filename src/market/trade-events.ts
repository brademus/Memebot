import { env } from '../config';
import { pool } from '../db';
import { TradeEvent } from '../types';

interface PendingTradeEvent extends TradeEvent { ca: string; eventId: string }
interface AggregateFlowSample { buys: number; sells: number; volumeUsd: number; at: number }

const pending: PendingTradeEvent[] = [];
const aggregateLatest = new Map<string, AggregateFlowSample>();
let flushing = false;
const diag = {
  written: 0, dropped: 0, retries: 0, aggregateSamples: 0,
  lastFlush: null as string | null, lastAggregateAt: null as string | null,
  lastError: null as string | null,
};
export const tradeEventDiag = () => ({
  ...diag,
  queued: pending.length,
  aggregateTokens: aggregateLatest.size,
  eventStreamConfigured: !!env.PUMPPORTAL_API_KEY,
  mode: env.PUMPPORTAL_API_KEY ? 'wallet_event_stream' : 'dexscreener_aggregate_fallback',
});

export function recordTradeEvent(ca: string, event: TradeEvent) {
  if (!ca || !event.at) return;
  const eventId = event.signature
    ? `${event.signature}:${event.wallet || ''}:${event.buy ? 'buy' : 'sell'}`
    : `${event.slot || 0}:${event.at}:${event.wallet || ''}:${event.buy ? 'buy' : 'sell'}:${event.tokenAmount || 0}`;
  pending.push({ ca, eventId, ...event });
  if (pending.length > 20_000) {
    const overflow = pending.length - 20_000;
    pending.splice(0, overflow);
    diag.dropped += overflow;
  }
}

// Dexscreener exposes rolling aggregate flow even when the metered PumpPortal wallet
// event stream is unavailable. These samples are intentionally not inserted into
// trade_events because they are not individual wallet events. They still feed the
// aggregate burst proxy and are durably captured inside signal_observations.
export function recordAggregateFlowSample(ca: string, sample: AggregateFlowSample) {
  if (!ca || !sample.at) return;
  const previous = aggregateLatest.get(ca);
  if (previous && previous.buys === sample.buys && previous.sells === sample.sells
      && previous.volumeUsd === sample.volumeUsd) return;
  aggregateLatest.set(ca, sample);
  diag.aggregateSamples++;
  diag.lastAggregateAt = new Date(sample.at).toISOString();
  if (aggregateLatest.size > 2_000) {
    const oldest = [...aggregateLatest.entries()].sort((left, right) => left[1].at - right[1].at)
      .slice(0, aggregateLatest.size - 2_000);
    for (const [mint] of oldest) aggregateLatest.delete(mint);
  }
}

export function startTradeEventWriter() {
  if (!pool) return;
  const timer = setInterval(() => flush().catch(() => {}), 1_000); timer.unref();
  const first = setTimeout(() => flush().catch(() => {}), 2_000); first.unref();
}
export async function flushTradeEvents() { await flush(); }

async function flush() {
  if (!pool || flushing || !pending.length) return;
  flushing = true; diag.lastError = null;
  try {
    while (pending.length) {
      const batch = pending.splice(0, 250);
      const values: unknown[] = [];
      const tuples = batch.map((event, index) => {
        const offset = index * 12;
        values.push(
          event.eventId,event.ca,new Date(event.at),event.buy ? 'buy' : 'sell',event.wallet || null,
          finiteOrNull(event.solAmount),finiteOrNull(event.tokenAmount),finiteOrNull(event.priceUsd),
          finiteOrNull(event.curveSol),event.slot || null,event.signature || null,'pumpfun',
        );
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12})`;
      });
      try {
        const result = await pool.query(
          `INSERT INTO trade_events
             (event_id,ca,at,side,wallet,sol_amount,token_amount,price_usd,curve_sol,slot,signature,source)
           VALUES ${tuples.join(',')} ON CONFLICT (ca,event_id) DO NOTHING`, values,
        );
        diag.written += result.rowCount || 0;
      } catch (error) {
        pending.unshift(...batch);
        diag.retries++;
        throw error;
      }
    }
    diag.lastFlush = new Date().toISOString();
  } catch (error) {
    diag.lastError = (error as Error).message;
    console.error('[trade-events]', diag.lastError);
  } finally { flushing = false; }
}
function finiteOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
