import { pumpfunStreamDiag } from '../ingest/pumpfun';
import { heliusHealth } from '../helius';
import { geminiDiag } from '../ai/gemini';
import { heliusFreeBudgetDiag } from '../helius-free-budget';
import { pumpPortalGuardDiag } from '../ingest/pumpportal-guard';
import { pumpPortalPersistentBudgetDiag } from '../ingest/pumpportal-persistent-budget';

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

/** Diag modules are side-effectful; never let one crashing take the whole status board down. */
function safeDiag<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

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
  pumpportal?: any; helius?: any; gemini?: any; heliusBudget?: any;
  pumpportalBudget?: any; pumpportalGuard?: any; now?: number;
}): PaidServiceLight[] {
  const now = overrides?.now ?? Date.now();
  const rows: PaidServiceLight[] = [];

  // ---- PumpPortal (paid trade data, per-message billing) ----
  const pp = overrides?.pumpportal ?? pumpfunStreamDiag();
  const ppBudget = overrides?.pumpportalBudget ?? safeDiag(pumpPortalPersistentBudgetDiag);
  const ppGuard = overrides?.pumpportalGuard ?? safeDiag(pumpPortalGuardDiag);
  const ppGreen = pp?.effectiveMode === 'full';
  // Root-cause precedence (2026-07-30, found the hard way): when the bot's OWN
  // persistent event budget is exhausted, the guard silently swallows every
  // subscribe frame — zero acks, zero trades, on every fresh socket, surviving
  // reboots — and the stream-level heuristic then falsely blames the provider
  // wallet ("check the PumpPortal wallet balance"). That misdirection cost a
  // multi-hour investigation chasing keys, clients, and IP theories around our
  // own spending governor. The budget pause is the more specific truth and must
  // be stated first.
  const budgetPaused = !ppGreen && ppBudget && ppBudget.available === false;
  const ppReason = ppGreen
    ? null
    : budgetPaused
      ? `Paid-event budget exhausted (${ppBudget?.actualToday ?? '?'} events today / ${ppBudget?.dailyEventLimit ?? '?'} daily; 14d ${ppBudget?.actualRolling14d ?? '?'}/${ppBudget?.rolling14dEventLimit ?? '?'}) — stream paused by the bot's own spending governor, resumes at UTC midnight. The provider wallet is NOT the problem.`
      : humanPumpportalReason(String(pp?.reason || 'unknown'), pp?.messages?.lastProtocolError);
  rows.push({
    id: 'pumpportal',
    name: 'PumpPortal trade stream',
    status: ppGreen ? 'green' : 'red',
    reason: ppReason,
    detail: {
      effectiveMode: pp?.effectiveMode ?? null,
      lastTradeAt: pp?.messages?.lastTradeAt ?? pp?.lastTradeAt ?? null,
      tradesReceived: pp?.messages?.tradesReceived ?? null,
      budget: ppBudget ? {
        available: ppBudget.available ?? null,
        exhausted: ppBudget.exhausted ?? null,
        eventsToday: ppBudget.actualToday ?? null,
        dailyEventLimit: ppBudget.dailyEventLimit ?? null,
        eventsRolling14d: ppBudget.actualRolling14d ?? null,
        rolling14dEventLimit: ppBudget.rolling14dEventLimit ?? null,
        estimatedCostTodaySol: ppBudget.estimatedActualCostTodaySol ?? null,
      } : null,
      guard: ppGuard ? {
        activeSlots: ppGuard.activeCount ?? ppGuard.active ?? null,
        pendingKeys: ppGuard.pendingBudgetKeys ?? ppGuard.pending ?? null,
        suppressedOverBudgetKeys: ppGuard.suppressedOverBudgetKeys ?? null,
        subscribeCommandsOnWire: ppGuard.subscribeCommands ?? null,
        budgetTripped: ppGuard.budgetTripped ?? null,
      } : null,
      // Diagnostic depth (2026-07-30): the earlier version hid exactly the
      // fields needed to tell "still ramping up after a fresh boot" apart from
      // "genuinely stuck" — both looked identical from the outside. These come
      // straight from the same diag object, read-only, no behavior change.
      connected: pp?.connected ?? null,
      createsSinceBoot: pp?.messages?.creates ?? null,
      socketOpenAt: pp?.connection?.lastSocketOpenAt ?? pp?.lastSocketOpenAt ?? null,
      connectionAttempts: pp?.connection?.attempts ?? null,
      reconnects: pp?.connection?.reconnects ?? null,
      entitlementCycles: pp?.connection?.entitlementCycles ?? null,
      staleAfterWorkingResets: pp?.connection?.staleAfterWorkingResets ?? null,
      lastProtocolError: pp?.messages?.lastProtocolError ?? null,
      lastSocketError: pp?.connection?.lastSocketError ?? null,
    },
  });

  // ---- Helius (RPC + enhanced APIs, credit-metered) ----
  const helius = overrides?.helius ?? heliusHealth();
  const heliusSuccessAgeMs = helius?.lastSuccessAt ? now - new Date(helius.lastSuccessAt).getTime() : Number.POSITIVE_INFINITY;
  const heliusFailedAfterSuccess = helius?.lastFailureAt && helius?.lastSuccessAt
    ? new Date(helius.lastFailureAt).getTime() > new Date(helius.lastSuccessAt).getTime()
    : !!helius?.lastFailureAt;
  const heliusBudget = overrides?.heliusBudget ?? heliusFreeBudgetDiag();
  const rpcExhausted = heliusBudget && heliusBudget.estimatedRpcCreditsRemaining === 0;
  const enhancedExhausted = heliusBudget && heliusBudget.estimatedCreditsRemaining === 0;
  let heliusReason: string | null = null;
  let heliusRed = false;
  if (!helius?.configured) { heliusReason = 'No API key configured (HELIUS_API_KEY).'; heliusRed = true; }
  else if (rpcExhausted) {
    // RPC is the cheap, essential category (mint/freeze/LP-lock don't use
    // Helius at all, but bundle/deployer insider-detection does, and both FAIL
    // OPEN on error) — exhausting it is a real "not working" state worth
    // flagging in red, not just a cost-control pause.
    heliusReason = `RPC credit budget spent (${heliusBudget.estimatedRpcCreditsUsed}/${heliusBudget.dailyRpcBudgetCredits} estimated) — Helius calls paused until UTC midnight.`;
    heliusRed = true;
  } else if (heliusFailedAfterSuccess && helius?.lastError) { heliusReason = `Last call failed: ${String(helius.lastError)}`; heliusRed = true; }
  else if (heliusSuccessAgeMs > STALE_SUCCESS_MS) { heliusReason = `No successful call in ${Math.round(heliusSuccessAgeMs / 60_000)} minutes.`; heliusRed = true; }
  else if (enhancedExhausted) {
    // Core Helius (RPC) is healthy; only the expensive enrichment category
    // (insider/bundle address-history lookups) is paused. Green stays accurate
    // — nothing essential is down — but the note matters: less enrichment
    // coverage today, worth knowing since insider-clean is the one proven edge.
    heliusReason = `Enhanced-API budget spent (${heliusBudget.estimatedEnhancedCreditsUsed}/${heliusBudget.dailyBudgetCredits} estimated) — insider/bundle enrichment paused until UTC midnight; RPC unaffected.`;
  }
  rows.push({
    id: 'helius',
    name: 'Helius (RPC + wallet data)',
    status: heliusRed ? 'red' : 'green',
    reason: heliusReason,
    detail: {
      lastSuccessAt: helius?.lastSuccessAt ?? null,
      throttledCalls: helius?.throttledCalls ?? null,
      got429: helius?.got429 ?? null,
      estCreditsToday: heliusBudget?.estimatedCreditsUsed ?? null,
      dailyBudget: heliusBudget?.dailyBudgetCredits ?? null,
      estEnhancedCreditsToday: heliusBudget?.estimatedEnhancedCreditsUsed ?? null,
      estRpcCreditsToday: heliusBudget?.estimatedRpcCreditsUsed ?? null,
      dailyRpcBudget: heliusBudget?.dailyRpcBudgetCredits ?? null,
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
