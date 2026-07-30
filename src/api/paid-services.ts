import { pumpfunStreamDiag } from '../ingest/pumpfun';
import { heliusHealth } from '../helius';
import { geminiDiag } from '../ai/gemini';
import { heliusFreeBudgetDiag } from '../helius-free-budget';

/**
 * One light per PAID service, with the reason when it's red. Born from the week
 * the PumpPortal wallet ran dry twice and an invalid key hid behind a generic
 * status for a day: every provider we pay gets a green/red verdict computed from
 * its own live diagnostics, and red always carries the provider's words or the
 * precise prerequisite that's missing. Diags are injectable for tests.
 */

export interface PaidServiceLight {
  id: string;
  name: string;
  status: 'green' | 'red';
  reason: string | null;
  detail: Record<string, unknown>;
}

const STALE_SUCCESS_MS = 15 * 60_000;

function humanPumpportalReason(reason: string, protocolError: unknown): string {
  const providerWords = (() => {
    if (!protocolError) return '';
    if (typeof protocolError === 'string') return ` Provider says: ${protocolError}`;
    const errors = (protocolError as any)?.errors;
    return errors ? ` Provider says: ${String(errors)}` : '';
  })();
  const map: Record<string, string> = {
    api_key_missing: 'No API key configured (PUMPPORTAL_API_KEY).',
    api_key_has_outer_quotes: 'API key is wrapped in quotes — remove them in Railway.',
    pumpportal_rejected_or_errored: `Provider rejected the connection.${providerWords}`,
    socket_not_open: 'Websocket not connected.',
    no_token_trade_events_received: 'Connected, but no trade events received yet.',
    paid_trade_channel_silent_while_free_channels_deliver__check_pumpportal_wallet_balance:
      'Paid trade channel silent while free channels deliver — check the PumpPortal wallet balance.',
    token_trade_stream_stale: 'Trade stream stale — no recent trade events.',
  };
  return map[reason] || `${reason}.${providerWords}`;
}

export function buildPaidServicesStatus(overrides?: {
  pumpportal?: any; helius?: any; gemini?: any; heliusBudget?: any; now?: number;
}): PaidServiceLight[] {
  const now = overrides?.now ?? Date.now();
  const rows: PaidServiceLight[] = [];

  // ---- PumpPortal (paid trade data, per-message billing) ----
  const pp = overrides?.pumpportal ?? pumpfunStreamDiag();
  const ppGreen = pp?.effectiveMode === 'full';
  rows.push({
    id: 'pumpportal',
    name: 'PumpPortal trade stream',
    status: ppGreen ? 'green' : 'red',
    reason: ppGreen ? null : humanPumpportalReason(String(pp?.reason || 'unknown'), pp?.messages?.lastProtocolError),
    detail: {
      effectiveMode: pp?.effectiveMode ?? null,
      lastTradeAt: pp?.messages?.lastTradeAt ?? pp?.lastTradeAt ?? null,
      tradesReceived: pp?.messages?.tradesReceived ?? null,
    },
  });

  // ---- Helius (RPC + enhanced APIs, credit-metered) ----
  const helius = overrides?.helius ?? heliusHealth();
  const heliusSuccessAgeMs = helius?.lastSuccessAt ? now - new Date(helius.lastSuccessAt).getTime() : Number.POSITIVE_INFINITY;
  const heliusFailedAfterSuccess = helius?.lastFailureAt && helius?.lastSuccessAt
    ? new Date(helius.lastFailureAt).getTime() > new Date(helius.lastSuccessAt).getTime()
    : !!helius?.lastFailureAt;
  const heliusBudget = overrides?.heliusBudget ?? heliusFreeBudgetDiag();
  const budgetSpent = heliusBudget && heliusBudget.estimatedCreditsRemaining === 0;
  let heliusReason: string | null = null;
  if (!helius?.configured) heliusReason = 'No API key configured (HELIUS_API_KEY).';
  else if (budgetSpent) heliusReason = `Daily credit budget spent (${heliusBudget.estimatedCreditsUsed}/${heliusBudget.dailyBudgetCredits} estimated) — Helius calls paused until UTC midnight.`;
  else if (heliusFailedAfterSuccess && helius?.lastError) heliusReason = `Last call failed: ${String(helius.lastError)}`;
  else if (heliusSuccessAgeMs > STALE_SUCCESS_MS) heliusReason = `No successful call in ${Math.round(heliusSuccessAgeMs / 60_000)} minutes.`;
  rows.push({
    id: 'helius',
    name: 'Helius (RPC + wallet data)',
    status: heliusReason ? 'red' : 'green',
    reason: heliusReason,
    detail: {
      lastSuccessAt: helius?.lastSuccessAt ?? null,
      throttledCalls: helius?.throttledCalls ?? null,
      got429: helius?.got429 ?? null,
      estCreditsToday: heliusBudget?.estimatedCreditsUsed ?? null,
      dailyBudget: heliusBudget?.dailyBudgetCredits ?? null,
      topBurner: (() => {
        const entries = Object.entries(heliusBudget?.byCategory || {});
        if (!entries.length) return null;
        entries.sort((left, right) => Number(right[1]) - Number(left[1]));
        return `${entries[0][0]} (${entries[0][1]} est credits)`;
      })(),
    },
  });

  // ---- Gemini (AI analyst, prepaid credits) ----
  const gem = overrides?.gemini ?? geminiDiag();
  let gemReason: string | null = null;
  if (!gem?.configured) gemReason = 'No API key configured (GEMINI_API_KEY).';
  else if (gem?.hardBlocked) gemReason = `Provider hard-blocked: ${String(gem?.lastError || 'quota exhausted')}.${gem?.recovery ? ` Recovery: ${gem.recovery}` : ''}`;
  else if (gem?.retryAfterAt) gemReason = `Rate-limited until ${gem.retryAfterAt}.`;
  else if (gem?.lastError && !gem?.lastSuccessAt) gemReason = `Last call failed: ${String(gem.lastError)}`;
  rows.push({
    id: 'gemini',
    name: 'Gemini (AI analyst)',
    status: gemReason ? 'red' : 'green',
    reason: gemReason,
    detail: {
      lastSuccessAt: gem?.lastSuccessAt ?? null,
      calls: gem?.calls ?? null,
      blockedCalls: gem?.blockedCalls ?? null,
    },
  });

  return rows;
}
